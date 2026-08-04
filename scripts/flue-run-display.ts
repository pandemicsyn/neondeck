'use agent';

import { DisplayAssistant } from '../src/agents/display-assistant';
import { installNeondeckProviders } from '../src/modules/repos';

await installNeondeckProviders();

export { DisplayAssistant };
