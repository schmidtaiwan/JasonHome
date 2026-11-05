/* 輕音樂：八音盒旋律加很輕的和弦，循環播放。要在使用者按過按鈕後才開始。 */
(function (global) {
  const LOOP = 16;
  const melody = [
    [0.0, 72, 1.4],
    [1.5, 76, 1.3],
    [3.0, 79, 1.8],
    [5.0, 76, 1.2],
    [6.5, 74, 1.6],
    [8.2, 69, 1.3],
    [9.6, 72, 1.4],
    [11.2, 76, 1.8],
    [13.0, 74, 1.2],
    [14.4, 72, 1.6]
  ];
  const chords = [
    [0, [60, 64, 67]],
    [4, [57, 60, 64]],
    [8, [65, 69, 72]],
    [12, [62, 67, 71]]
  ];

  let ctx = null;
  let master = null;
  let timer = 0;
  let playing = false;

  function freq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function envGain(when, peak, attack, hold, release) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(peak * 0.6, when + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + hold + release);
    return gain;
  }

  function box(when, midi, dur) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq(midi), when);
    const gain = envGain(when, 0.09, 0.02, dur * 0.35, dur * 0.65);
    osc.connect(gain);
    gain.connect(master);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  function pad(when, midis) {
    midis.forEach(function (midi) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq(midi), when);
      const gain = envGain(when, 0.018, 0.4, 2.6, 0.9);
      osc.connect(gain);
      gain.connect(master);
      osc.start(when);
      osc.stop(when + 4.2);
    });
  }

  function schedule(when) {
    melody.forEach(function (note) {
      box(when + note[0], note[1], note[2]);
    });
    chords.forEach(function (chord) {
      pad(when + chord[0], chord[1]);
    });
  }

  function arm() {
    schedule(ctx.currentTime + 0.08);
    timer = setInterval(function () {
      schedule(ctx.currentTime + 0.08);
    }, LOOP * 1000);
  }

  function start() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC || playing) return;
    try {
      if (!ctx) ctx = new AC();
      const go = function () {
        if (playing) return;
        if (!master) {
          master = ctx.createGain();
          master.gain.value = 0.55;
          master.connect(ctx.destination);
        }
        playing = true;
        arm();
      };
      if (ctx.state === "suspended") ctx.resume().then(go).catch(function () {});
      else go();
    } catch (e) { /* 這台裝置沒有音訊 */ }
  }

  global.JHMusic = {
    start: start,
    playing: function () { return playing; }
  };
})(window);
