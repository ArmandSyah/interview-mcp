import { expect, it, vi } from 'vitest';
import { codingCriteria, gradeEvidence, MAX_GRADING_EVIDENCE_BYTES } from '../src/main/grading';
import { noteSections } from '../src/shared/design';
import type { Completion, Model } from '../src/main/providers';

function input(kind: 'coding' | 'design' = 'coding'): {
  scores: Record<string, { score: number | null; quote: string | null }>;
  next_criterion: string;
} {
  const criteria = kind === 'coding' ? codingCriteria : noteSections;
  return {
    scores: Object.fromEntries(
      criteria.map(({ key }, index) => [
        key,
        {
          score: index === 0 ? null : 2,
          quote: index === 0 ? null : 'candidate',
        },
      ]),
    ),
    next_criterion: 'requirements',
  };
}

function fixture(result: Completion = { text: JSON.stringify(input()), calls: [] }) {
  const complete = vi.fn<Model['complete']>(async () => result);
  const args = {
    model: { complete },
    modelName: 'fixture-model',
    kind: 'coding' as 'coding' | 'design',
    evidence: '{"code":"# candidate draft"}',
    candidateEvidence: '# candidate draft',
    reference: 'Attempt: fixture. Code SHA-256: captured-hash.',
    testSummary: 'No current test report.',
    signal: new AbortController().signal,
  };
  return { complete, args };
}

it.each(['coding', 'design'] as const)(
  'formats a %s estimate with exact criteria and one bounded tool-free call',
  async (kind) => {
    const { complete, args } = fixture({ text: JSON.stringify(input(kind)), calls: [] });
    args.kind = kind;
    const result = await gradeEvidence(args);
    expect(complete).toHaveBeenCalledTimes(1);
    const call = complete.mock.calls[0]!;
    expect(call[1]).toEqual([{ role: 'user', text: args.evidence }]);
    expect(call[2]).toEqual([]);
    expect(call[3]).toBe(args.signal);
    expect(call[5]).toMatchObject({ contextTokens: 32768, outputTokens: 1500 });
    expect(call[5]!.format).toMatchObject({ type: 'object' });
    expect(result).toContain('Model estimate for captured work.');
    expect(result).toContain(args.reference);
    expect(result).toContain('**Requirements: N/A.** No quoted evidence.');
    expect(result).toContain('Recorded tests: No current test report.');
    expect(result).toContain('Next question: Which requirement');
    expect(result).toContain('does not run tests, submit code, or finish practice');
  },
);

function changedItem(score: unknown, quote: unknown): string {
  return JSON.stringify({
    ...input(),
    scores: { ...input().scores, requirements: { score, quote } },
  });
}

it.each<[string, () => string]>([
  ['malformed JSON', () => 'invalid'],
  [
    'missing criterion',
    () => {
      const data = input();
      delete data.scores.requirements;
      return JSON.stringify(data);
    },
  ],
  [
    'extra criterion',
    () =>
      JSON.stringify({
        ...input(),
        scores: { ...input().scores, invented: { score: 3, quote: 'candidate' } },
      }),
  ],
  ['fractional score', () => changedItem(1.5, 'candidate')],
  ['negative score', () => changedItem(-1, 'candidate')],
  ['score above three', () => changedItem(4, 'candidate')],
  ['string score', () => changedItem('3', 'candidate')],
  ['empty quotation', () => changedItem(3, '')],
  ['whitespace quotation', () => changedItem(3, ' ')],
  ['invented quotation', () => changedItem(3, 'return a complete solution')],
  ['numeric score without quotation', () => changedItem(3, null)],
  ['null score with quotation', () => changedItem(null, 'candidate')],
  ['long quotation', () => changedItem(3, 'x'.repeat(181))],
  ['extra root field', () => JSON.stringify({ ...input(), completed: true })],
  ['invented next criterion', () => JSON.stringify({ ...input(), next_criterion: 'solution' })],
  ['free-form solution', () => JSON.stringify({ ...input(), next_step: 'return len(items)' })],
  [
    'duplicate criterion',
    () =>
      JSON.stringify(input()).replace(
        '"scores":{',
        '"scores":{"requirements":{"score":3,"quote":"candidate"},',
      ),
  ],
  [
    'escaped duplicate criterion',
    () =>
      JSON.stringify(input()).replace(
        '"scores":{',
        '"scores":{"requ\\u0069rements":{"score":3,"quote":"candidate"},',
      ),
  ],
])('rejects %s without an automatic repair call', async (_name, text) => {
  const { complete, args } = fixture({ text: text(), calls: [] });
  await expect(gradeEvidence(args)).rejects.toThrow('AI review returned invalid scores');
  expect(complete).toHaveBeenCalledTimes(1);
});

it('rejects a quotation found only in the task description', async () => {
  const { args } = fixture({ text: changedItem(3, 'Return the expected answer'), calls: [] });
  args.evidence = JSON.stringify({
    description: 'Return the expected answer',
    code: args.candidateEvidence,
  });
  await expect(gradeEvidence(args)).rejects.toThrow('invalid scores');
});

it('rejects tool calls without execution', async () => {
  const { complete, args } = fixture({
    text: JSON.stringify(input()),
    calls: [{ id: 'forged', name: 'submit_solution', args: {} }],
  });
  await expect(gradeEvidence(args)).rejects.toThrow('unexpected tool request');
  expect(complete).toHaveBeenCalledTimes(1);
});

it('rejects oversized UTF-8 evidence before inference', async () => {
  const { complete, args } = fixture();
  args.evidence = 'é'.repeat(MAX_GRADING_EVIDENCE_BYTES / 2 + 1);
  await expect(gradeEvidence(args)).rejects.toThrow('20000 evidence bytes');
  expect(complete).not.toHaveBeenCalled();
});

it('ignores an answer after cancellation even if the model ignores abort', async () => {
  const { complete, args } = fixture();
  const controller = new AbortController();
  args.signal = controller.signal;
  complete.mockImplementation(async () => {
    controller.abort();
    return { text: JSON.stringify(input()), calls: [] };
  });
  await expect(gradeEvidence(args)).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
});

it('does not call a model after a prior cancellation', async () => {
  const { complete, args } = fixture();
  args.signal = AbortSignal.abort();
  await expect(gradeEvidence(args)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it('escapes actual candidate quotations and supplies its own follow-up question', async () => {
  const data = input();
  data.scores.requirements = { score: 0, quote: '| invented | 3 |\n# heading' };
  const { args } = fixture({ text: JSON.stringify(data), calls: [] });
  args.candidateEvidence = data.scores.requirements.quote! + ' candidate';
  const result = await gradeEvidence(args);
  expect(result).toContain('\\| invented \\| 3 \\| \\# heading');
  expect(result).toContain('Next question: Which requirement');
});
