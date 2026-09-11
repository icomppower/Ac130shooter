// The synthesis in this module is carried over verbatim from
// icomppower/ac130astra. It already worked; it is not re-derived here. Only the
// import path below and the additions at the end of the class are new.
//
// Everything is synthesized at runtime: no prerecorded actors, no music files,
// no external sound assets, nothing to download. That keeps the zero-runtime-
// dependency posture intact apart from Three.js in the render layer.
import type {RadioMessage} from '../sim/types';
export class AudioManager {
 ctx:AudioContext|null=null;master:GainNode|null=null;muted=false;voice=false;private nextAmbient=0;private noise:AudioBuffer|null=null;
 init(){if(this.ctx){this.ctx.resume();return;}this.ctx=new AudioContext();this.master=this.ctx.createGain();this.master.gain.value=.32;this.master.connect(this.ctx.destination);const n=this.ctx.sampleRate*2;this.noise=this.ctx.createBuffer(1,n,this.ctx.sampleRate);const data=this.noise.getChannelData(0);for(let i=0;i<n;i++)data[i]=Math.random()*2-1;}
 setMute(){this.muted=!this.muted;if(this.master)this.master.gain.value=this.muted?0:.32;if(this.muted&&'speechSynthesis' in globalThis)speechSynthesis.cancel();}
 tone(freq:number,duration:number,volume=.12,type:OscillatorType='sine',end?:number){if(!this.ctx||!this.master||this.muted)return;const now=this.ctx.currentTime,o=this.ctx.createOscillator(),g=this.ctx.createGain();o.type=type;o.frequency.setValueAtTime(freq,now);if(end)o.frequency.exponentialRampToValueAtTime(end,now+duration);g.gain.setValueAtTime(volume,now);g.gain.exponentialRampToValueAtTime(.001,now+duration);o.connect(g);g.connect(this.master);o.start();o.stop(now+duration);}
 burst(duration:number,volume:number,freq:number){if(!this.ctx||!this.master||!this.noise||this.muted)return;const now=this.ctx.currentTime,s=this.ctx.createBufferSource(),f=this.ctx.createBiquadFilter(),g=this.ctx.createGain();s.buffer=this.noise;f.type='lowpass';f.frequency.value=freq;g.gain.setValueAtTime(volume,now);g.gain.exponentialRampToValueAtTime(.001,now+duration);s.connect(f);f.connect(g);g.connect(this.master);s.start();s.stop(now+duration);}
 fire(i:number){this.burst([.1,.24,.5][i],[.25,.6,.9][i],[1700,1100,650][i]);this.tone([140,90,52][i],[.12,.3,.7][i],.3,'triangle',25);}
 impact(i:number){this.burst(i===2?1.8:i===0?.16:.6,i===2?.7:.3,500);this.tone(i===2?42:70,.8,.3,'sine',20);}
 radio(m:RadioMessage){this.burst(.12,.1,2200);this.tone(m.priority>=4?1050:680,.09,.09);if(this.voice&&!this.muted&&'speechSynthesis' in globalThis){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(m.text);u.rate=1.1;u.pitch=.75;u.volume=.7;speechSynthesis.speak(u);}}
 update(time:number,phase:number){if(time<this.nextAmbient)return;this.nextAmbient=time+4;this.burst(3,.025,180);this.tone(55,3,.025);if(phase>=3)this.tone(82,2,.025);}
 end(won:boolean){this.tone(won?261:110,1.4,.18);setTimeout(()=>this.tone(won?392:82,1.6,.14),250);}

 // --------------------------------------------------------------------------
 // Additions for the escort rebuild. The synthesis above is astra's, unchanged.
 // --------------------------------------------------------------------------

 /** A looping noise source off the shared buffer, for sustained beds. */
 private loop(){if(!this.ctx||!this.noise)return null;const s=this.ctx.createBufferSource();s.buffer=this.noise;s.loop=true;return s;}

 /** Danger-close and priority-threat warnings. Deliberately unpleasant. */
 warn(urgent:boolean){if(urgent){this.tone(880,.12,.16,'square');setTimeout(()=>this.tone(660,.16,.14,'square'),130);}else this.tone(520,.14,.1,'triangle');}

 /** The weapons-free window opening. A rising sting, then the guns speed up. */
 weaponsFree(){this.tone(180,.5,.2,'sawtooth',720);this.burst(.35,.14,2400);}

 /** The aircraft's own engine bed, started once and left running. */
 private engine:{gain:GainNode;nodes:AudioScheduledSourceNode[]}|null=null;
 startEngine(){
  if(!this.ctx||!this.master||this.engine)return;
  const g=this.ctx.createGain();g.gain.value=.16;g.connect(this.master);
  const nodes:AudioScheduledSourceNode[]=[];
  const n=this.loop();
  if(n){const f=this.ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=135;const ng=this.ctx.createGain();ng.gain.value=.7;n.connect(f);f.connect(ng);ng.connect(g);n.start();nodes.push(n);}
  // Four turboprops: a low sawtooth with a slow beat between the pairs.
  const o=this.ctx.createOscillator();o.type='sawtooth';o.frequency.value=54;
  const of=this.ctx.createBiquadFilter();of.type='lowpass';of.frequency.value=118;
  const og=this.ctx.createGain();og.gain.value=.34;
  o.connect(of);of.connect(og);og.connect(g);o.start();nodes.push(o);
  const lfo=this.ctx.createOscillator();lfo.frequency.value=5.5;
  const lg=this.ctx.createGain();lg.gain.value=.13;
  lfo.connect(lg);lg.connect(og.gain);lfo.start();nodes.push(lfo);
  this.engine={gain:g,nodes};
 }

 /**
  * The extraction helicopter, ported directly from the Canvas build: pulsed
  * noise rotor whomp, tail-rotor buzz and turbine whine, mixed deliberately
  * louder than anything before it. This is the climax and the audio has to
  * sell it, so it is the one thing in the mix allowed to dominate.
  */
 private helo:{gain:GainNode;nodes:AudioScheduledSourceNode[]}|null=null;
 startHelo(){
  if(!this.ctx||!this.master||this.helo)return;
  const t0=this.ctx.currentTime;
  const hg=this.ctx.createGain();
  hg.gain.setValueAtTime(.0001,t0);
  hg.gain.exponentialRampToValueAtTime(.95,t0+6);   // fade in on the approach
  hg.connect(this.master);
  const nodes:AudioScheduledSourceNode[]=[];
  const BLADE=10.8;  // main rotor blade-pass, Hz
  // Main rotor: two noise layers whose gain is chopped at the blade-pass rate.
  for (const [freq,type,base,depth] of [[170,'bandpass',.5,.45],[85,'lowpass',.45,.4]] as const){
   const n=this.loop();if(!n)continue;
   const f=this.ctx.createBiquadFilter();f.type=type;f.frequency.value=freq;
   const g=this.ctx.createGain();g.gain.value=base;
   const lfo=this.ctx.createOscillator();lfo.type='square';lfo.frequency.value=BLADE;
   const lg=this.ctx.createGain();lg.gain.value=depth;
   lfo.connect(lg);lg.connect(g.gain);
   n.connect(f);f.connect(g);g.connect(hg);
   n.start();lfo.start();nodes.push(n,lfo);
  }
  // Tail rotor buzz, tremolo at twice the blade rate.
  const tr=this.ctx.createOscillator();tr.type='square';tr.frequency.value=54;
  const trf=this.ctx.createBiquadFilter();trf.type='lowpass';trf.frequency.value=240;
  const trg=this.ctx.createGain();trg.gain.value=.05;
  const trl=this.ctx.createOscillator();trl.frequency.value=BLADE*2;
  const trlg=this.ctx.createGain();trlg.gain.value=.03;
  trl.connect(trlg);trlg.connect(trg.gain);
  tr.connect(trf);trf.connect(trg);trg.connect(hg);
  tr.start();trl.start();nodes.push(tr,trl);
  // Turbine whine.
  const tw=this.ctx.createOscillator();tw.type='sawtooth';tw.frequency.value=520;
  const twf=this.ctx.createBiquadFilter();twf.type='highpass';twf.frequency.value=420;
  const twg=this.ctx.createGain();twg.gain.value=.02;
  tw.connect(twf);twf.connect(twg);twg.connect(hg);
  tw.start();nodes.push(tw);
  this.helo={gain:hg,nodes};
 }
 stopHelo(fade=2){
  if(!this.ctx||!this.helo)return;
  const h=this.helo;this.helo=null;
  const now=this.ctx.currentTime;
  h.gain.gain.setValueAtTime(Math.max(h.gain.gain.value,.0001),now);
  h.gain.gain.exponentialRampToValueAtTime(.0001,now+fade);
  setTimeout(()=>{for(const n of h.nodes){try{n.stop();}catch{/* already stopped */}}h.gain.disconnect();},fade*1000+200);
 }

 /** Distant firefight layer, keyed to how much is happening on the ground. */
 firefight(intensity:number){
  if(intensity<=0)return;
  const rounds=Math.min(4,1+Math.floor(intensity*3));
  for(let i=0;i<rounds;i++)setTimeout(()=>this.burst(.05,.02+intensity*.03,900+i*140),i*90+Math.random()*70);
 }

 /** Called once on teardown so a restart does not stack beds on top of beds. */
 stopAll(){
  this.stopHelo(.3);
  if(this.engine){for(const n of this.engine.nodes){try{n.stop();}catch{/* already stopped */}}this.engine.gain.disconnect();this.engine=null;}
  if('speechSynthesis' in globalThis)speechSynthesis.cancel();
 }
}
