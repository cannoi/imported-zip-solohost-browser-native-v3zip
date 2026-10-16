'use strict';
const assert = require('assert');
const bridge = require('./lib/engine/dom-bridge');
const backend = require('./lib/backend-agent');
const evidence = require('./lib/agent-evidence');
const ai = {
  configured: () => true,
  async complete() { return { mode:'json', provider:'mock', model:'fixture', text: JSON.stringify({ thought:'complete fixture task', action:{ type:'done', summary:'Done.' } }) }; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const owner = await bridge.createSession({ tabKey:'isolation-owner', clientKey:'test-owner', privateMode:true, persist:false });
  const ownerSession = bridge.authSession(owner.sessionId, owner.token);
  assert.ok(ownerSession, 'owner session created');
  const a = await backend.start({ ai, session:ownerSession, task:'Task A: private sentinel', lang:'en', maxSteps:3, maxMs:60000 });
  const taskA = backend.getTask(a.taskId, ownerSession.id);
  assert.ok(taskA && taskA.session && taskA.session.id !== ownerSession.id, 'task A has its own bridge session');
  evidence.addEvidence(a.taskId, { kind:'page', url:'https://task-a.example/story', title:'Task A', snippet:'TASK_A_PRIVATE_SENTINEL', text:'TASK_A_PRIVATE_SENTINEL' });
  // Simulate the old client attempting to inject task A's output into task B.
  const b = await backend.start({ ai, session:ownerSession, task:'Task B: independent task', lang:'en', maxSteps:3, maxMs:60000,
    history:[{ thought:'TASK_A_PRIVATE_SENTINEL', action:{ type:'navigate', url:'https://task-a.example/story' } }],
    workMemory:{ findings:[{ fact:'TASK_A_PRIVATE_SENTINEL', url:'https://task-a.example/story' }], notes:['TASK_A_PRIVATE_SENTINEL'], visited:['https://task-a.example/story'] }
  });
  const taskB = backend.getTask(b.taskId, ownerSession.id);
  assert.ok(taskB && taskB.session && taskB.session.id !== ownerSession.id && taskB.session.id !== taskA.session.id, 'task B gets a distinct isolated session');
  assert.deepStrictEqual(taskB.history, [], 'client history ignored for a new task');
  assert.deepStrictEqual(taskB.workMemory.findings, [], 'client findings ignored for a new task');
  assert.deepStrictEqual(taskB.workMemory.notes, [], 'client notes ignored for a new task');
  let final;
  for (let i=0;i<60;i++) { final = backend.status(b.taskId, ownerSession.id, 0); if (final && ['done','failed','stopped','limit'].includes(final.status)) break; await sleep(50); }
  assert.ok(final && final.status === 'done', 'task B reaches a terminal report');
  assert.ok(!String(final.message).includes('TASK_A_PRIVATE_SENTINEL'), 'task B report cannot contain task A sentinel');

  // Continue must resume the same task id/session ledger rather than start a fresh task.
  const c = await backend.start({ ai, session:ownerSession, task:'Task C: resumable task', lang:'en', maxSteps:10, maxMs:60000 });
  const taskC = backend.getTask(c.taskId, ownerSession.id);
  evidence.addEvidence(c.taskId, { kind:'page', url:'https://task-c.example/source', title:'Task C source', snippet:'TASK_C_EVIDENCE', text:'TASK_C_EVIDENCE' });
  taskC.stop = true;
  let stopped;
  for (let i=0;i<40;i++) { stopped = backend.status(c.taskId, ownerSession.id, 0); if (stopped && stopped.status === 'stopped') break; await sleep(25); }
  assert.ok(stopped && stopped.status === 'stopped', 'fixture task reaches stopped state');
  const resumed = await backend.continueTask(c.taskId, ownerSession.id);
  assert.strictEqual(resumed.taskId, c.taskId, 'continue retains original task id');
  let resumedStatus;
  for (let i=0;i<60;i++) { resumedStatus = backend.status(c.taskId, ownerSession.id, 0); if (resumedStatus && ['done','failed','stopped','limit'].includes(resumedStatus.status)) break; await sleep(50); }
  assert.ok(resumedStatus && resumedStatus.status === 'done', 'continued task completes');
  assert.ok(String(resumedStatus.message).includes('TASK_C_EVIDENCE'), 'continued task retains its original evidence ledger');

  evidence.clearTaskEvidence(a.taskId); evidence.clearTaskEvidence(b.taskId); evidence.clearTaskEvidence(c.taskId);
  await bridge.destroySession(ownerSession.id).catch(()=>{});
  console.log('test-agent-v1031-task-isolation PASS');
})().catch(e => { console.error(e); process.exitCode=1; });
