import assert from'node:assert/strict';
import{defaultModel}from'../src/engine/presets';
import{compileModel}from'../src/engine/compile';
import{Simulation,type Vehicle}from'../src/engine/sim';
const cfg=defaultModel('v1');cfg.sim.mode='strict';cfg.sim.diagnosticRecovery=false;
const sim=new Simulation(cfg,compileModel(cfg).code,{headless:true});
try{
 sim.runUntil(30);const base=sim.st.vehicles[0];assert.ok(base);const turn=sim.net.conns.find(c=>c.conn.id==='W0-N0'&&c.variant===0)!;assert.ok(turn);
 const bus:Vehicle={...structuredClone(base),id:10001,kind:'bus',origin:'W',dest:'N',lane:0,targetLane:0,conn:turn.idx,phase:'conn',s:13.135954130678234,v:0,a:0,len:12,wid:2.55,s0:1.5,lat:0,lat2:0,route:null,stopsLeft:[],committed:[],crashed:false,bayT:0,bayShift:0,lcT:-1};
 const follower:Vehicle={...structuredClone(bus),id:10002,kind:'car',phase:'approach',s:sim.net.arms.W.cfg.approachLength-.2,len:4.5,wid:1.8};
 const x=sim as unknown as{hasStagingSpace(v:Vehicle,ci:number):boolean;index():void;accel(v:Vehicle):number};
 assert.equal(x.hasStagingSpace(bus,turn.idx),true,'Стоящий автобус не перекрывает встречные траектории');
 assert.ok(bus.s-bus.len>0&&bus.s-bus.len<bus.s0);
 sim.st.vehicles=[bus,follower];sim.st.peds=[];sim.permit.fill('main');sim.pose(bus);sim.pose(follower);x.index();
 const gap=sim.net.arms.W.cfg.approachLength+bus.s-bus.len-follower.s;
 assert.ok(gap<follower.s0);assert.ok(x.accel(follower)<0,'Следующий водитель сохраняет обычную дистанцию до автобуса');
 console.log('Место ожидания не перекрывает встречный поток, дистанция следующего водителя сохранена.');
}finally{sim.dispose();}
