import assert from'node:assert/strict';
import{stopPointAcceleration,travelDistance}from'../src/engine/kinematics';
const B=7;let cases=0;
for(const dt of[.02,.05,.1,.2,.4])for(const speed of[.1,.38463076571403343,1,3.524238842020292,10,20])for(const factor of[1,1.001,1.1,2,10]){
 const room=speed*speed/(2*B)*factor;
 const a=Math.max(-B,Math.min(-.01,stopPointAcceleration(speed,room,dt,B)));
 const ds=travelDistance(speed,a,dt),v=Math.max(0,speed+a*dt);
 assert.ok(ds<=room+1e-8,'Текущий шаг не пересекает точку ожидания');
 assert.ok(v*v/(2*B)<=room-ds+1e-8,'На следующем шаге сохраняется место для остановки');cases++;
}
const speed=.38463076571403343,room=.01417733;
assert.ok(travelDistance(speed,stopPointAcceleration(speed,room,.1,B),.1)<=room+1e-9);
assert.ok(stopPointAcceleration(3.524238842020292,6.5,.1,B)>0,'Удалённая точка ожидания не усиливает уже выбранное торможение');
console.log(`Проверка точки ожидания: ${cases} случаев без нарушения условия остановки.`);
