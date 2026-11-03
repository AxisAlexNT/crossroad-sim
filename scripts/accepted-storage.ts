import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateSession } from '../src/engine/session';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
const {cfg}=migrateSession(JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.session.json',import.meta.url),'utf8')));
const sim=new Simulation(cfg,compileModel(cfg).code,{headless:true});
try{
 sim.runUntil(60);const base=sim.st.vehicles[0];assert.ok(base);
 const left=sim.net.conns.find(c=>c.conn.id==='E0-S0'&&c.variant===0)!;
 const straight=sim.net.conns.find(c=>c.conn.id==='W1-E1'&&c.variant===0)!;
 const cr=left.conflicts.find(r=>r.other===straight.idx&&sim.net.conflicts[r.conflict].kind==='cross'&&!sim.net.conflicts[r.conflict].body)!;assert.ok(cr);
 const make=(id:number,conn:number,s:number):Vehicle=>({...structuredClone(base),id,conn,s,phase:'conn',v:0,a:0,len:4.3,wid:1.8,lat:0,lat2:0,origin:sim.net.conns[conn].conn.from.arm,dest:sim.net.conns[conn].conn.to.arm,committed:[],acceptedGrants:undefined,route:null,crashed:false,bayT:0,bayShift:0});
 const receiver=make(10001,left.idx,23.1567),giver=make(10002,straight.idx,14.4993);
 receiver.committed=[cr.conflict];receiver.acceptedGrants={[cr.conflict]:giver.id};
 giver.why='yield';giver.yieldTo=receiver.id;giver.yieldingAt=cr.conflict+1;
 sim.st.vehicles=[receiver,giver];
 const internal=sim as unknown as {index():void;acceptSiblingGrant(v:Vehicle,ci:number,o:Vehicle):boolean};
 for(const v of sim.st.vehicles)sim.pose(v);internal.index();
 assert.equal(internal.acceptSiblingGrant(receiver,receiver.conn,giver),true,'Принятая уступка сохраняется при ожидании места перед более ранней зоной');
 giver.v=1;assert.equal(internal.acceptSiblingGrant(receiver,receiver.conn,giver),false);
 giver.v=0;giver.yieldTo=999;assert.equal(internal.acceptSiblingGrant(receiver,receiver.conn,giver),false,'Ожидание другой машины не является новой уступкой');
 giver.yieldTo=receiver.id;receiver.s=cr.end+receiver.len+1;sim.pose(receiver);
 assert.equal(internal.acceptSiblingGrant(receiver,receiver.conn,giver),false,'Уже освобождённая зона не даёт постоянного преимущества');
 console.log('Принятая уступка: очередь перед ранней зоной, адресат и окончание права проезда проверены.');
}finally{sim.dispose();}
