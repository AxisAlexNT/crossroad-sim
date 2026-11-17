import assert from'node:assert/strict';

import{defaultModel}from'../src/engine/presets';import{compileModel}from'../src/engine/compile';import{Simulation}from'../src/engine/sim';
const cfg=defaultModel('v1');const sim=new Simulation(cfg,compileModel(cfg).code,{headless:true}),x=sim as any;
try{sim.runUntil(30);const base=sim.st.vehicles[0];assert.ok(base);sim.st.vehicles=[];sim.st.peds=[];x.index();const ci=0;const cf=sim.net.conflicts.findIndex(c=>!c.same&&!c.body&&c.kind==='cross');assert.ok(cf>=0);const origin=sim.net.conns[ci].conn.from.arm;const other=sim.net.conns.find(c=>c.conn.from.arm!==origin)!.idx;
 const first={...sim.net.conns[ci].conflicts[0],conflict:cf,other,start:0,end:1};
 const veh={...structuredClone(base),conn:ci,len:4.5,s0:1.5,committed:[]};
 for(const nextStart of[6.75,9]){const next={...first,start:nextStart,end:nextStart+1};sim.net.conns[ci].conflicts=[first,next];x.mustWait=(_v:any,_ci:any,ref:any)=>ref===next;
  const rearAtNextStop=nextStart-1-veh.s0-veh.len;const overlapsPrevious=rearAtNextStop<first.end;assert.equal(x.wouldStopInside(veh,ci,first,2),overlapsPrevious,'Ожидание перед следующей зоной сохраняет место всему кузову после предыдущей зоны');
 }
 console.log(JSON.stringify({fullBodyStoppingSpace:true,clearNextZoneAllowed:true}));
}finally{sim.dispose();}
