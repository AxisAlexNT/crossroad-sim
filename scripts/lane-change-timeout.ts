import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
const cfg = defaultModel('v1'); cfg.sim.missedTurn = 'wait'; cfg.sim.lcPatience = 120;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const arm = Object.values(sim.net.arms).find(a => a.cfg.inLanes >= 2)!;
  const from = arm.cfg.id;
  let lane = -1, targetLane = -1, dest = '';
  for (let i = 0; i < arm.cfg.inLanes; i++) for (let j = 0; j < arm.cfg.inLanes; j++) {
    const d = sim.net.reachable[from][j].find(d => !sim.net.reachable[from][i].includes(d));
    if (d && sim.net.reachable[from][i].length && Math.abs(i-j)===1) { lane=i; targetLane=j; dest=d; }
  }
  assert.ok(lane >= 0 && dest);
  const v: Vehicle = { ...structuredClone(base), id: 10001, phase: 'approach', origin: from, dest,
    lane, targetLane, s: arm.lcS - 20, v: 0, a: 0, lcT: -1, lcWaitSince: -1,
    conn: -1, route: null, illegal: false, solidCross: false, why: 'lc', committed: [], acceptedGrants: undefined,
    viol: { solid: false, turn: false, stop: false, red: false }, dwellUntil: -1,
  };
  const tail = { ...structuredClone(v), id: 10002, lane: targetLane, targetLane, s: v.s+v.len+2, why: 'leader' as const };
  sim.st.vehicles=[v,tail];sim.st.peds=[];
  const internal=sim as unknown as {index():void;accel(v:Vehicle):number};
  for(const item of sim.st.vehicles)sim.pose(item);internal.index();
  internal.accel(v);
  assert.equal(v.why,'lc');
  assert.equal(v.lcWaitSince,sim.st.t,'Ожидание начинается у хвоста очереди вдали от сплошной');
  const initialDest=v.dest, initialS=v.s;
  sim.st.t+=120;internal.accel(v);
  assert.notEqual(v.dest,initialDest,'По истечении 120 секунд выбирается разрешённое направление своей полосы');
  assert.ok(sim.net.reachable[from][lane].includes(v.dest));
  assert.equal(v.lane,lane); assert.equal(v.s,initialS,'Машина не переносится на свободное место');
  assert.equal(v.lcWaitSince,-1);assert.ok(sim.st.counters.missedTurns>0);
  v.dest=sim.net.reachable[from][lane][0]; v.targetLane=targetLane; v.lcWaitSince=sim.st.t-121; internal.accel(v);
  assert.equal(v.targetLane,v.lane,'Необязательный переход в соседнюю полосу прекращается по истечении терпения');
  assert.equal(v.lcWaitSince,-1);
  console.log('Перестроение: ожидание у хвоста очереди ограничено без перемещения сквозь машины.');
}finally{sim.dispose();}
