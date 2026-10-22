import type { DesignScene } from '../shared/design';

export function canvasElements(
  elements: readonly Record<string, unknown>[],
  previous: DesignScene['elements'],
): DesignScene['elements'] {
  const byId = new Map(previous.map((element) => [element.id, element]));
  return elements.map((element) => {
    // Excalidraw changes null bindings to [] on load. Both mean no bindings.
    // Keep the saved representation so an unchanged review keeps its digest.
    const keepNull =
      byId.get(element.id)?.boundElements === null &&
      Array.isArray(element.boundElements) &&
      element.boundElements.length === 0;
    return {
      ...element,
      ...(keepNull ? { boundElements: null } : {}),
      link: null,
    };
  });
}
