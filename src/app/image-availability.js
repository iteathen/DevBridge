import { ImageArtifactAcquisition } from '../runtime/image-artifact-acquisition.js';
import { createRecoverableImageCache } from './recoverable-image-cache.js';

export function createImageAvailability({ recoveryDirectory, quarantineDirectory, library, source, codec } = {}) {
  const local = createRecoverableImageCache({ library, quarantineDirectory });
  const acquisition = new ImageArtifactAcquisition({ directory: recoveryDirectory, local, source, codec });
  return Object.freeze({ ensure: (request) => acquisition.ensure(request) });
}
