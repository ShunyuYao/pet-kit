'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Motion}=require('../src/index');
const options={delayMs:150,interpolate:(a,b,f)=>({x:a.x+(b.x-a.x)*f})};
test('batched delivery follows sample time, never the arrival spacing',()=>{
 const m=Motion.create(options);m.push({time:0,value:{x:0}},1000);m.push({time:100,value:{x:10}},1100);m.push({time:200,value:{x:20}},1300);m.push({time:300,value:{x:30}},1300);
 assert.equal(m.sample(1300).x,15);assert.equal(m.sample(1350).x,20);assert.equal(m.sample(1400).x,25);
});
test('projection is opt-in, bounded and reported',()=>{
 const m=Motion.create({...options,delayMs:0});m.push({time:0,value:{x:0}},0);m.push({time:100,value:{x:10}},100);assert.equal(m.sample(500).x,10);
 const p=Motion.create({...options,delayMs:0,maxProjectionMs:50,project:(a,b,ms)=>({x:b.x+ms*.1})});p.push({time:0,value:{x:0}},0);p.push({time:100,value:{x:10}},100);assert.equal(p.sample(500).x,15);assert.equal(p.stats().mode,'exhausted');
});
test('duplicate and out-of-order frames cannot rewind the timeline',()=>{
 const m=Motion.create(options);m.push({time:100,value:{x:10}},100);assert.equal(m.push({time:100,value:{x:999}},101),false);assert.equal(m.push({time:90,value:{x:999}},102),false);assert.equal(m.sample(200).x,10);assert.equal(m.stats().dropped,2);
});
test('new generation and long silence clear old frames and clock',()=>{
 const m=Motion.create(options);m.push({time:100,value:{x:10},key:'one'},100);m.push({time:0,value:{x:50},key:'two'},120);assert.equal(m.sample(130).x,50);m.push({time:10,value:{x:80},key:'two'},2200);assert.equal(m.sample(2300).x,80);assert.equal(m.stats().frames,1);m.reset();assert.equal(m.sample(3000),null);
});
test('sampling owns copies and never changes authoritative input or returned history',()=>{
 const source={x:1,nested:{n:2}},m=Motion.create(options);m.push({time:0,value:source},0);source.x=10;let v=m.sample(0);v.x=99;v.nested.n=99;assert.deepEqual(m.sample(0),{x:1,nested:{n:2}});
});
test('explicit discontinuities snap and do not project across teleports',()=>{
 const m=Motion.create({...options,discontinuous:(a,b)=>b.x-a.x>20});m.push({time:0,value:{x:0}},0);m.push({time:100,value:{x:100}},100);assert.equal(m.sample(180).x,100);
});
test('bounded retention, finite clocks and clock rollback protection',()=>{
 const m=Motion.create({...options,capacity:4});for(let i=0;i<20;i++)m.push({time:i*100,value:{x:i}},i*100);assert.equal(m.stats().frames,4);const a=m.sample(1900).x;assert(m.sample(1800).x>=a);assert.throws(()=>m.push({time:NaN,value:{}},0));assert.throws(()=>m.sample(Infinity));assert.throws(()=>Motion.create({delayMs:-1}));
});
