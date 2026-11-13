import { layerCategory } from './layers.js';
import { planQuestion } from './planner.js';

// A session not opened yet files under the layers its first question will
// turn on; planning is pure, so each question is planned once.
const pendingLayers = new Map();
const layersOfPending = (question) => {
  if (!pendingLayers.has(question))
    pendingLayers.set(question, planQuestion(question).layers || []);
  return pendingLayers.get(question);
};

/**
 * The category a session files under when grouped by layer: the layers its
 * last answer put on screen (whichever of GEV's agent and the planner
 * answered), else those its waiting question will.
 */
export function categoryOf(session) {
  const layers =
    (session.layers?.length ? session.layers : null) ||
    session.turns.findLast((turn) => turn.plan?.layers?.length)?.plan.layers ||
    session.pending.map(layersOfPending).find((ids) => ids.length);
  if (layers?.length) return layerCategory(layers[0]);
  return session.turns.length || session.pending.length ? 'other' : 'new';
}
