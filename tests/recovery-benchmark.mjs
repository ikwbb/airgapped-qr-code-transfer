// Deterministic end-to-end protocol simulation. Run: node tests/recovery-benchmark.mjs
// Counts displayed QR frames (including metadata), not wall-clock camera throughput.
import { pathToFileURL } from 'node:url';
import { prepareTransfer, Receiver, makeSchedule, frameAt, GROUP } from '../protocol.js';

export function seededRandom(seed) {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

// The original v1 schedule, including its metadata cadence and shuffled repeats.
export function repeatSchedule(transfer, pass = 0, random = Math.random) {
  const frames = [];
  for (let i = 0; i < transfer.count; i++) {
    frames.push([1, i]);
    if ((i + 1) % GROUP === 0 || i === transfer.count - 1) frames.push([2, Math.floor(i / GROUP)]);
  }
  if (pass > 0) for (let i = frames.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [frames[i], frames[j]] = [frames[j], frames[i]];
  }
  const result = [[0, 0]];
  for (let i = 0; i < frames.length; i++) {
    result.push(frames[i]);
    if ((i + 1) % 15 === 0 && i < frames.length - 1) result.push([0, 0]);
  }
  return result;
}

export async function recoveryBenchmark({ trials = 20, blocks = 256 } = {}) {
  const random = seededRandom(32819);
  const bytes = Uint8Array.from({ length: blocks * 384 }, () => Math.floor(random() * 256));
  const transfer = await prepareTransfer(new File([bytes], 'loss-simulation.bin'), 384);
  const results = [];
  for (const model of ['30% independent loss', 'bursts averaging 5 frames']) {
    const samples = {};
    for (const [name, schedule] of [['repeat', repeatSchedule], ['repair', makeSchedule]]) {
      samples[name] = [];
      for (let trial = 0; trial < trials; trial++) {
        const randomSchedule = seededRandom(101 + trial * 7919);
        const randomLoss = seededRandom(617 + trial * 4999);
        const receiver = new Receiver();
        let sent = 0, burst = false;
        for (let pass = 0; pass < 20 && !receiver.complete; pass++) {
          for (const item of schedule(transfer, pass, randomSchedule)) {
            sent++;
            // Good->bad probability .086, bad->good .2 gives ~30% stationary loss.
            burst = model.startsWith('30%') ? randomLoss() < .3 : randomLoss() < (burst ? .8 : .086);
            if (!burst) receiver.accept(frameAt(transfer, item));
            if (receiver.complete) break;
          }
        }
        if (!receiver.complete) throw new Error(`${name} did not complete trial ${trial}`);
        // Every simulation verifies the assembled payload, not just a rank counter.
        await receiver.finish();
        samples[name].push(sent);
      }
    }
    const average = values => values.reduce((sum, n) => sum + n, 0) / values.length;
    const repeat = average(samples.repeat), repair = average(samples.repair);
    results.push({ model, trials, blocks: transfer.count, repeatFrames: +repeat.toFixed(1), repairFrames: +repair.toFixed(1), fewerFramesPercent: +(100 * (1 - repair / repeat)).toFixed(1) });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.table(await recoveryBenchmark());
}
