export function reviewJSON(kind: 'coding' | 'design' = 'coding'): string {
  const keys =
    kind === 'coding'
      ? ['requirements', 'approach', 'edge_cases', 'complexity']
      : ['requirements', 'api', 'data', 'capacity', 'tradeoffs', 'failure_modes'];
  return JSON.stringify({
    scores: Object.fromEntries(keys.map((key) => [key, { score: null, quote: null }])),
    next_criterion: 'requirements',
  });
}
