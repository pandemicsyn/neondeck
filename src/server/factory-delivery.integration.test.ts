import { it } from 'vitest';
import {
  deliveryModes,
  runDeliveryIntegration,
} from './factory-adapters-delivery.test-helper';

it.each(deliveryModes)(
  'production candidate-to-draft integration: %s',
  (mode) => runDeliveryIntegration(mode),
  360000,
);
