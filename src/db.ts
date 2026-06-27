import { sqlite } from '@flue/runtime/node';
import { ensureRuntimeHomeSync, runtimePaths } from './runtime-home';

const paths = runtimePaths();
ensureRuntimeHomeSync(paths);

export default sqlite(paths.flueDatabase);
