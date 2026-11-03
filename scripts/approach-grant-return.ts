import assert from 'node:assert/strict';
import {readFileSync}from'node:fs';
import {migrateSession}from'../src/engine/session';
import {compileModel}from'../src/engine/compile';
import {Simulation,type Vehicle}from'../src/engine/sim';
import type{ConflictRef}from'../src/engine/network';
const{cfg}=migrateSession(JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.session.json',import.meta.url),'utf8')));
const sim=new Simulation(cfg,compileModel(cfg).code,{headless:true});
try{
 sim.runUntil(60);const base=sim.st.vehicles[0];assert.ok(base);
 const giverConn=sim.net.conns.find(c=>c.conn.id==='X:E2-S0'&&c.variant===0)!;
 const leadConn=sim.net.conns.find(c=>c.conn.id==='S0-N0'&&c.variant===1)!;
 const receiverConn=sim.net.conns.find(c=>c.conn.id==='S0-W1'&&c.variant===1)!;
 assert.ok(giverConn&&leadConn&&receiverConn);
 const cr=giverConn.conflicts.find(r=>r.other===receiverConn.idx)!;assert.ok(cr);
 const make=(id:number,conn:number,s:number):Vehicle=>({...structuredClone(base),id,conn,s,lane:sim.net.conns[conn].conn.from.lane,outLane:sim.net.conns[conn].conn.to.lane,targetLane:sim.net.conns[conn].conn.from.lane,phase:'conn',v:0,a:0,len:4.6,wid:1.8,lat:0,lat2:0,tStop:10,origin:sim.net.conns[conn].conn.from.arm,dest:sim.net.conns[conn].conn.to.arm,committed:[],acceptedGrants:undefined,route:null,crashed:false,bayT:0,bayShift:0,lcT:-1});
 const internal=sim as unknown as{index():void;returnAcceptedGrant(v:Vehicle,A:number,r:ConflictRef,o:Vehicle):boolean};
 const setup=()=>{
  const giver=make(10001,giverConn.idx,26.1103),leader=make(10002,leadConn.idx,13.5377),receiver=make(10003,receiverConn.idx,129.1783);
  giver.lat=-.02715913;giver.lat2=.94776365;
  leader.lat=-.02952676;leader.lat2=-.70543685;leader.tStop=20;leader.why='yield';leader.yieldTo=giver.id;
  receiver.phase='approach';receiver.tStop=-1;receiver.lat=-.82989733;receiver.lat2=.54901601;
  receiver.why='leader';receiver.whyId=leader.id;receiver.committed=[cr.conflict];receiver.acceptedGrants={[cr.conflict]:giver.id};
  sim.st.vehicles=[giver,leader,receiver];for(const v of sim.st.vehicles)sim.pose(v);internal.index();
  return{giver,leader,receiver};
 };
 let v=setup();
 assert.equal(internal.returnAcceptedGrant(v.giver,v.giver.conn,cr,v.receiver),true,'An approach queue can return an unused grant through its stationary connector leader');
 assert.equal(v.receiver.acceptedGrants?.[cr.conflict],undefined);
 assert.equal(v.giver.acceptedGrants?.[cr.conflict],v.receiver.id);
 v=setup();v.receiver.v=1;
 assert.equal(internal.returnAcceptedGrant(v.giver,v.giver.conn,cr,v.receiver),false,'A moving recipient must keep its reservation');
 v=setup();v.giver.v=1;
 assert.equal(internal.returnAcceptedGrant(v.giver,v.giver.conn,cr,v.receiver),false,'A moving giver cannot negotiate a stationary return');
 v=setup();v.leader.phase='exit';internal.index();
 assert.equal(internal.returnAcceptedGrant(v.giver,v.giver.conn,cr,v.receiver),false,'An exit participant cannot create an approach cycle');
 console.log('Approach grant return: stationary queue, moving participants, ownership and exit exclusion checked.');
}finally{sim.dispose();}
