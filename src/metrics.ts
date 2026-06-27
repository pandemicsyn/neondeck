import os from 'node:os';
import si from 'systeminformation';

const CACHE_TTL_MS = 1_000;

let cachedMetrics: HostMetrics | undefined;
let cachedAt = 0;
let pendingMetrics: Promise<HostMetrics> | undefined;

export type HostMetrics = {
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  loadAverage: number[];
  cpuCount: number;
  cpuModel: string;
  cpu: {
    loadPercent: number | null;
    avgLoad: number | null;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usedRatio: number;
  };
  gpu: {
    name: string | null;
    utilizationPercent: number | null;
    temperatureC: number | null;
    memoryTotal: number | null;
    memoryUsed: number | null;
  };
  temperature: {
    cpuC: number | null;
    maxC: number | null;
  };
  network: {
    iface: string | null;
    downBytesPerSecond: number | null;
    upBytesPerSecond: number | null;
  };
  process: {
    uptimeSeconds: number;
    rss: number;
  };
  sampledAt: string;
};

export async function readHostMetrics() {
  const now = Date.now();
  if (cachedMetrics && now - cachedAt < CACHE_TTL_MS) return cachedMetrics;
  if (pendingMetrics) return pendingMetrics;

  pendingMetrics = sampleHostMetrics()
    .then((metrics) => {
      cachedMetrics = metrics;
      cachedAt = Date.now();
      return metrics;
    })
    .finally(() => {
      pendingMetrics = undefined;
    });

  return pendingMetrics;
}

async function sampleHostMetrics(): Promise<HostMetrics> {
  const [load, memory, graphics, temperature, networkStats] = await Promise.all(
    [
      nullable(() => si.currentLoad()),
      nullable(() => si.mem()),
      nullable(() => si.graphics()),
      nullable(() => si.cpuTemperature()),
      nullable(() => si.networkStats()),
    ],
  );

  const totalMemory = memory?.total ?? os.totalmem();
  const freeMemory = memory?.available ?? memory?.free ?? os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const cpus = os.cpus();
  const gpu = selectGpu(graphics?.controllers ?? []);
  const network = summarizeNetwork(networkStats ?? []);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptimeSeconds: Math.round(os.uptime()),
    loadAverage: os.loadavg(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpu: {
      loadPercent: finitePercent(load?.currentLoad),
      avgLoad: finiteNumber(load?.avgLoad),
    },
    memory: {
      total: totalMemory,
      free: freeMemory,
      used: usedMemory,
      usedRatio: totalMemory ? usedMemory / totalMemory : 0,
    },
    gpu: {
      name: gpu?.model ?? gpu?.name ?? null,
      utilizationPercent: finitePercent(gpu?.utilizationGpu),
      temperatureC: finiteNumber(gpu?.temperatureGpu),
      memoryTotal: bytesFromMiB(gpu?.memoryTotal ?? gpu?.vram ?? null),
      memoryUsed: bytesFromMiB(gpu?.memoryUsed ?? null),
    },
    temperature: {
      cpuC: finiteNumber(temperature?.main),
      maxC: finiteNumber(temperature?.max),
    },
    network,
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      rss: process.memoryUsage().rss,
    },
    sampledAt: new Date().toISOString(),
  };
}

async function nullable<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch {
    return null;
  }
}

function selectGpu(
  controllers: Awaited<ReturnType<typeof si.graphics>>['controllers'],
) {
  return (
    controllers.find(
      (controller) =>
        controller.utilizationGpu != null || controller.temperatureGpu != null,
    ) ??
    controllers.find((controller) => controller.external) ??
    controllers[0] ??
    null
  );
}

function summarizeNetwork(
  stats: Awaited<ReturnType<typeof si.networkStats>>,
): HostMetrics['network'] {
  const active = stats.filter((item) => {
    const hasRate = positiveRate(item.rx_sec) || positiveRate(item.tx_sec);
    return item.operstate === 'up' || hasRate;
  });

  const candidates = active.length > 0 ? active : stats;
  const validRates = candidates.filter(
    (item) => validRate(item.rx_sec) || validRate(item.tx_sec),
  );

  if (validRates.length === 0) {
    return {
      iface: candidates[0]?.iface ?? null,
      downBytesPerSecond: null,
      upBytesPerSecond: null,
    };
  }

  return {
    iface: validRates.map((item) => item.iface).join('+'),
    downBytesPerSecond: sumRates(validRates.map((item) => item.rx_sec)),
    upBytesPerSecond: sumRates(validRates.map((item) => item.tx_sec)),
  };
}

function validRate(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveRate(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sumRates(values: Array<number | null | undefined>) {
  let total = 0;
  let count = 0;

  for (const value of values) {
    if (!validRate(value)) continue;
    total += value;
    count += 1;
  }

  return count > 0 ? total : null;
}

function finiteNumber(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function finitePercent(value: number | null | undefined) {
  const number = finiteNumber(value);
  if (number == null) return null;
  return Math.max(0, Math.min(100, number));
}

function bytesFromMiB(value: number | null | undefined) {
  const number = finiteNumber(value);
  if (number == null) return null;
  return number * 1024 * 1024;
}
