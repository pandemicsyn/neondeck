// The profiling renderer keeps React Profiler callbacks enabled in production
// builds without changing the application renderer.
import { createRoot } from 'react-dom/profiling';
import {
  BenchmarkApp,
  benchmarkFixtureMetadata,
  readBenchmarkConfig,
} from './benchmark-app';
import { initializeBenchmarkMetrics } from './metrics';
import '../styles.css';
import './styles.css';

const config = readBenchmarkConfig(window.location.search);
initializeBenchmarkMetrics(
  `${config.surface}/${config.tier}/${config.variant}`,
  benchmarkFixtureMetadata(config),
);

createRoot(document.getElementById('root')!).render(
  <BenchmarkApp config={config} />,
);
