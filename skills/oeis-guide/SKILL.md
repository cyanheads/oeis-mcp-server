---
name: oeis-guide
description: Use oeis_* tools to verify an integer sequence against an OEIS entry, including a run from later in a sequence, a recurrence, or a program in a specific language.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use the OEIS to find published integer sequences and check candidate entries against the evidence you have. Agreement on a finite run supports an identification. A claim that two definitions give the same sequence needs a mathematical argument.

## Identifiers

Use the A-number returned by `oeis_identify_sequence` or `oeis_search_sequences` for entry lookups. For a legacy M-number or N-number, search it as a word and check the candidate entry's legacy IDs before using its A-number.

## Gates

- Before naming a candidate as the match, compare the supplied terms with their exact signed values at the expected indices, then read the entry's definition or formulas for agreement with how the terms were generated, when known. If multiple candidates still fit, report the ambiguity.
- After a term-search miss, account for search coverage: OEIS looks for runs in its short data lines. For a run later in a known candidate, use `oeis_get_terms` at the relevant indices and compare the returned `n` values as well as the terms.
- Before concluding that terms are absent, check the source and read notices for coverage. A short or empty b-file slice can leave the requested indices unread. Follow the returned continuation or the notice before concluding that the published terms end there.

## Workflows

- For a recurrence, use `oeis_list_reference` for search syntax. Quoted phrases and formula searches can fold signs and operators. Use the hits as candidates and fetch their formula lines with `oeis_get_sequence` before claiming an exact expression match.
- For code in a specific language, inspect the program blocks from `oeis_get_sequence`. Contributor tags are literal and can vary. Confirm the requested language from the tag and code before reusing a block.
- When continuing a partial result, keep the returned cursor with its original entry and selection. `nextFromIndex` is a sequence index. `nextFromItem` refers to an item in the selected entry sections.
