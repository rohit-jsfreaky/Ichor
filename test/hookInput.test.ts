/**
 * Which paths Ichor will even form an opinion about.
 *
 * `toRepoRelative` used to hand back ANY absolute path with its leading slash
 * stripped, so `C:/Users/…/AppData/Local/Temp/fixcn.js` became a repo-relative
 * path and the classifier judged it like source code. An agent writing a scratch
 * script to the system temp directory got challenged for scope expansion on a
 * file in no repository at all.
 *
 * A path is either in this repo or it is none of Ichor's business, and the
 * awkward cases — a lowercase drive letter, a `..` that leaves the tree, a
 * sibling directory that merely shares a prefix — are exactly where the old
 * version said "in".
 */

import { describe, expect, it } from 'vitest';

import { parseApplyPatch, parseHookInput, toRepoRelative } from '../src/hook/input.js';
import { scopeBriefing } from '../src/hook/prompt.js';

const ROOT = 'D:/work/myrepo';

describe('paths inside the repo', () => {
  it('takes an absolute path under the root', () => {
    expect(toRepoRelative('D:/work/myrepo/src/app.ts', ROOT)).toBe('src/app.ts');
  });

  it('takes a Windows path with backslashes', () => {
    expect(toRepoRelative('D:\\work\\myrepo\\src\\app.ts', ROOT)).toBe('src/app.ts');
  });

  it('takes a relative path, resolved against the root', () => {
    expect(toRepoRelative('src/app.ts', ROOT)).toBe('src/app.ts');
    expect(toRepoRelative('./src/app.ts', ROOT)).toBe('src/app.ts');
  });

  it('ignores drive-letter case, which hosts disagree about', () => {
    expect(toRepoRelative('d:/work/myrepo/src/app.ts', ROOT)).toBe('src/app.ts');
  });

  it('resolves a `..` that stays inside', () => {
    expect(toRepoRelative('D:/work/myrepo/src/../lib/x.ts', ROOT)).toBe('lib/x.ts');
  });

  it('treats the root itself as inside', () => {
    expect(toRepoRelative('D:/work/myrepo', ROOT)).toBe('');
  });
});

describe('paths that are not this repo', () => {
  it('rejects the system temp directory — the case seen in a real session', () => {
    expect(toRepoRelative('C:/Users/x/AppData/Local/Temp/fixcn.js', ROOT)).toBeUndefined();
  });

  it('rejects a different drive', () => {
    expect(toRepoRelative('E:/other/src/app.ts', ROOT)).toBeUndefined();
  });

  it('rejects a `..` that escapes the root', () => {
    expect(toRepoRelative('D:/work/myrepo/../other/src/app.ts', ROOT)).toBeUndefined();
    expect(toRepoRelative('../other/src/app.ts', ROOT)).toBeUndefined();
  });

  it('rejects a sibling that merely shares the root\'s prefix', () => {
    // The old check was `startsWith(root)`, which called this one inside and
    // returned `-backup/src/app.ts` as a repo-relative path.
    expect(toRepoRelative('D:/work/myrepo-backup/src/app.ts', ROOT)).toBeUndefined();
  });
});

describe('what the hook does with an outside path', () => {
  it('produces no intent, and reports the path instead', () => {
    const parsed = parseHookInput(
      {
        tool_name: 'Write',
        tool_input: { file_path: 'C:/Users/x/AppData/Local/Temp/scratch.js', content: 'x' },
      },
      ROOT,
    );
    expect(parsed.intents).toEqual([]);
    expect(parsed.outside).toEqual(['C:/Users/x/AppData/Local/Temp/scratch.js']);
  });

  it('still judges the files in the same patch that ARE in the repo', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '+const x = 1;',
      '*** Add File: /tmp/scratch.ts',
      '+const y = 2;',
      '*** End Patch',
    ].join('\n');

    const { intents, outside } = parseApplyPatch(patch, ROOT);
    expect(intents.map((i) => i.file)).toEqual(['src/app.ts']);
    expect(outside).toEqual(['/tmp/scratch.ts']);
  });
});

/**
 * The scope briefing is injected by a hook, so the agent sees it where a developer's
 * own words would be.
 *
 * In a live session an agent read the quoted task as a fresh request, reported it as
 * an injected instruction that "didn't come from you", and ignored the whole
 * briefing. That instinct is right and it costs Ichor half its value, so the origin
 * has to be unmistakable before the task text ever appears.
 */
describe('the scope briefing announces what it is', () => {
  const task = {
    task: 'add a comment at the top of smtp-service.ts saying it sends mail',
    members: [
      { id: 1, name: 'sendMail', file: 'src/smtp.ts', distance: 0, reason: 'anchor' },
    ],
    coreModels: [],
    mode: 'watch',
    sessionId: 'session-a',
  } as unknown as Parameters<typeof scopeBriefing>[0];

  const briefing = scopeBriefing(task, 'session-a');

  it('says it is not a message from the developer', () => {
    expect(briefing).toMatch(/not a message from the developer/);
  });

  /**
   * Not "ignore this". An earlier version said "do not act on the quoted task text"
   * and an agent correctly read that as making the whole block inert: a tracked job
   * with a scope and an escalation path is the shape of work you ARE expected to
   * judge yourself against.
   */
  it('says the job is in progress rather than telling the agent to ignore it', () => {
    expect(briefing).toMatch(/ALREADY IN PROGRESS/);
    expect(briefing).toMatch(/judge whether an edit you are about to make/);
    expect(briefing).not.toMatch(/Do not act on/);
  });

  it('lists the FILES in scope, because a verdict is about a file', () => {
    expect(briefing).toMatch(/Files in scope \(1\): src\/smtp\.ts/);
    // Both routes named: a shell write is gated too, so promising only about
    // 'an edit' would understate what Ichor actually does now.
    expect(briefing).toMatch(/Any file change outside that list will be questioned/);
    expect(briefing).toMatch(/edit tool or a shell command/);
  });

  /**
   * A rule the reader cannot apply is not a rule. With 91 files in scope and 8 shown,
   * an agent said: *"nothing in the hook lets me determine membership for the other 83.
   * The enforcement claim is stronger than the information provided."*
   */
  it('admits the file list is partial instead of claiming an unusable rule', () => {
    const many = {
      ...task,
      members: Array.from({ length: 40 }, (_, i) => ({
        id: i,
        name: `handler${i}`,
        file: `src/area${i}/thing.ts`,
        distance: 0,
        reason: 'anchor',
      })),
    } as typeof task;

    const briefed = scopeBriefing(many, 'session-a');
    expect(briefed).toMatch(/Files in scope: 40, of which 8 shown/);
    expect(briefed).toMatch(/the list above is partial/);
    expect(briefed).toMatch(/ichor check <path>/);
    expect(briefed).not.toMatch(/outside that list will be questioned/);
  });

  it('says where the quoted task came from, when it was this conversation', () => {
    expect(briefing).toMatch(/from an earlier message in this conversation/);
  });

  /**
   * A boundary outlives the session that set it, and an agent caught the first
   * version claiming otherwise: *"There is no earlier message in this conversation —
   * your question is the first turn I've seen."* A briefing caught in one false
   * statement earns distrust of every true one beside it.
   */
  it('does not claim an earlier message when the session is new', () => {
    const fresh = scopeBriefing(task, 'a-different-session');
    expect(fresh).not.toMatch(/in this conversation/);
    expect(fresh).toMatch(/carried over from an earlier session/);
  });

  it('says so when the task was named by hand instead', () => {
    const explicit = { ...task, mode: 'explicit' } as typeof task;
    expect(scopeBriefing(explicit, 'a-different-session')).toMatch(/set by hand with/);
  });

  it('states its origin before the task text, not after', () => {
    expect(briefing.indexOf('NOT a request')).toBeLessThan(briefing.indexOf('smtp-service.ts'));
  });

  it('still says what is in scope and what happens outside it', () => {
    expect(briefing).toMatch(/Functions in scope — 1, 1 distinct name: sendMail/);
    expect(briefing).toMatch(/will be questioned/);
  });

  /**
   * Two different functions can share a name, and they are two members. Printing the
   * raw list then shows the same word twice — which an agent reading the briefing
   * reported as the count being wrong. The count was right; the display was not.
   */
  it('does not print the same name twice, and separates the two counts', () => {
    const shared = {
      ...task,
      members: [
        { id: 1, name: 'handler', file: 'src/a.ts', distance: 0, reason: 'anchor' },
        { id: 2, name: 'handler', file: 'src/b.ts', distance: 0, reason: 'anchor' },
      ],
    } as typeof task;

    const briefed = scopeBriefing(shared, 'session-a');
    expect(briefed).toMatch(/Functions in scope — 2, 1 distinct name: handler$/m);
    expect(briefed).not.toMatch(/handler, handler/);
  });
});
