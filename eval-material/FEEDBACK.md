# Feedback for Ahmed

Hey Ahmed, here is how the evaluation-data side went for me. I'm not an engineer, so this is from a beginner's point of view.

## What was easy
- The row format is simple. Prompt, better answer, wrong answer. I got it right away.
- The reasons a row gets rejected are listed clearly in the docs. That helped a lot when I wrote the checker.
- Having a status page for my uploads is good. I like seeing what was accepted.

## What confused me
- The shell example on the contribute page looks like it has a missing `$`, and it writes `intentid` where the real field is `intent_id`. I had to guess.
- The 85% similarity rule is hard to predict. Two prompts that read different to me were still flagged. I ended up writing my own checker for it.
- It was not clear to me when a new contributor can tell if their material "counts". The rule that an Intent is ignored until 5 different people contributed is easy to miss. I only found it by reading closely.
- The bounty pages mention an "evaluator adapter", but the upload page only talks about data. I wasn't sure whether the data part alone is enough, so I only did the data part.
- Some free chain data hosts block old data. I lost time working out which ones could answer questions about old blocks.

## Suggestions
1. Put a "check my file" button on the dashboard that runs the same checks as the real upload but saves nothing.
2. Show the 5-contributor rule at the top of each Intent page, with a counter like "2 of 5 so far".
3. Fix the example command on the contribute page, and add one full working example row per Intent.
4. When a row is flagged as a near duplicate, say which other row it matches.
5. List a few recommended free data sources for old blocks, so people don't waste time on hosts that block them.
6. Say clearly on each bounty page whether data-only work is enough, or whether the adapter is required too.

Happy to jump on a call if any of this is unclear.
