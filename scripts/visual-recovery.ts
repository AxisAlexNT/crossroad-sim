import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateSession } from '../src/engine/session';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle, type SimState } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';
const { cfg } = migrateSession(JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.session.json', import.meta.url), 'utf8')));
const replay = JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.replay.json', import.meta.url), 'utf8')) as {state:SimState};
for (const mode of ['strict','visual'] as const) {
  const model=structuredClone(cfg);model.sim.mode=mode;model.sim.crashDuration=1200;
  const sim=new Simulation(model,compileModel(model).code,{headless:true});
  const internal=sim as unknown as {visualRecovery(ids:number[],since:number):void;makeCrash(vs:Vehicle[]):void;expireCrashes():void;index():void;accel(v:Vehicle):number};
  try {
    sim.restore(replay.state); const ids=sim.st.status.deadlock!.vids;
    internal.visualRecovery(ids,sim.st.t-61);
    assert.equal(sim.st.counters.interventions,mode==='visual'?1:0);
    assert.ok(sim.st.vehicles.every(v=>v.ghostUntil<=sim.st.t),'Наглядный разъезд не отключает проверку столкновений');
    if(mode==='visual') {
      assert.ok(sim.st.status.lastIntervention?.text.includes('разъезд'));
      const held=sim.st.vehicles.find(v=>v.visualYieldTo!==undefined)!;assert.ok(held);
      assert.ok(internal.accel(held)<0,'Участники ждут завершения согласованного проезда');
      assert.ok(invalidRunReasons(sim.st.counters,0).includes('вмешательства модели'));
    }
    sim.restore(replay.state);
    const first=structuredClone(sim.st.vehicles.find(v=>v.id===ids[0])!);
    const second={...structuredClone(first),id:999999};
    sim.st.vehicles=[first,second];internal.index();
    const exited=sim.st.counters.exited;
    internal.visualRecovery([first.id,second.id],sim.st.t-121);
    assert.equal(sim.st.vehicles.length,mode==='visual'?1:2);
    assert.equal(sim.st.counters.removedRecovery,mode==='visual'?1:0);
    assert.equal(sim.st.counters.exited,exited,'Эвакуация не считается завершённой поездкой');
    sim.restore(replay.state);
    const crashed=sim.st.vehicles[0]; internal.makeCrash([crashed]);
    assert.equal(crashed.crashUntil-sim.st.t,mode==='visual'?90:1200);
    sim.st.t+=90;internal.expireCrashes();
    assert.equal(sim.st.vehicles.some(v=>v.id===crashed.id),mode==='strict');
    if(mode==='visual')assert.equal(sim.st.counters.interventions,1);
  }finally{sim.dispose();}
}
{
  const model=structuredClone(cfg);model.sim.mode='strict';model.sim.diagnosticRecovery=true;model.sim.deadlockBreak=1;
  const sim=new Simulation(model,compileModel(model).code,{headless:true});
  try {
    sim.restore(replay.state);
    const internal=sim as unknown as {diagnose():void};internal.diagnose();
    assert.ok(sim.st.vehicles.every(v=>v.ghostUntil<=sim.st.t),'Явный строгий режим не включает старый диагностический проезд сквозь машины');
    assert.equal(sim.st.counters.interventions,0);
  }finally{sim.dispose();}
}
console.log('Наглядный и строгий режимы: безопасное согласование, явная эвакуация, учёт вмешательств и аварий проверены.');
