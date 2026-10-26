/**
 * Make a DimensionManager's layout loads come from `produce(layoutKey)`, as
 * the reader worker hands them: in display coordinates (fitted with
 * `normalizePositions`, in place) with the transform that maps them.
 */
import { normalizePositions } from '../../assets/js/rendering/gl-utils.js';

export function loadsAsReader(manager, produce) {
  manager.loadLayout = async layoutKey => {
    const positions = await produce(layoutKey);
    const layout = manager.getLayout(layoutKey);
    manager.loadedTransformCache.set(layout.layoutKey, normalizePositions(positions, layout.dimension));
    return positions;
  };
}
