/**
 * Client half: a compact memory ring in the composer dock.
 * It reads one number from the plugin's own read-only endpoint, so the figure stays on screen
 * instead of in every prompt. One timer, removed with the slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-lifeguard',
  factory(load) {
    const React = load('react');
    const h = React.createElement;
    const POLL_MS = 5000;
    const SIZE = 16;
    const STROKE = 2.5;
    const RADIUS = (SIZE - STROKE) / 2;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
    const DANGER = 85;
    const WARN = 70;
    const RED = '#e5484d';
    const AMBER = '#d9930d';
    /* 感叹号字号，只给字形用。 */
    const MARK_FONT = 9;

    function colorOf(pct) {
      if (pct >= DANGER) return RED;
      if (pct >= WARN) return AMBER;
      return 'currentColor';
    }

    function hintOf(state) {
      if (!state || !Number.isFinite(state.pct)) return '内存读数还没到';
      if (state.pct >= 100) return '注意随时可能崩溃';
      if (state.pct >= DANGER) return '内存接近上限，重启 DSH 才会释放';
      return `内存占用 ${state.heapMB} MB`;
    }

    function Ring(props) {
      const pct = Math.max(0, Math.min(100, props.pct));
      const color = colorOf(pct);
      const danger = pct >= DANGER;
      /* 越松越淡，接近告警才回实色。 */
      const weight = danger ? 1 : pct >= WARN ? 0.8 : pct >= 50 ? 0.5 : 0.32;
      const arc = h('circle', { key: 'arc', cx: SIZE / 2, cy: SIZE / 2, r: RADIUS, fill: 'none', stroke: color, strokeWidth: STROKE, strokeLinecap: 'round', strokeDasharray: CIRCUMFERENCE, strokeDashoffset: CIRCUMFERENCE * (1 - pct / 100), opacity: weight, transform: `rotate(-90 ${SIZE / 2} ${SIZE / 2})` });
      const track = h('circle', { key: 'track', cx: SIZE / 2, cy: SIZE / 2, r: RADIUS, fill: 'none', stroke: 'currentColor', strokeWidth: STROKE, opacity: 0.22 });
      const parts = [track, arc];
      /* 字号 9、抬半像素：感叹号才不压到圈线。 */
      if (danger) parts.push(h('text', { key: 'mark', x: SIZE / 2, y: SIZE / 2 - 0.5, textAnchor: 'middle', dominantBaseline: 'central', fontSize: MARK_FONT, fontWeight: 800, fill: color }, '!'));
      return h('svg', { width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`, 'aria-hidden': true, style: { display: 'block', flex: 'none' } }, parts);
    }

    function Health() {
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        const pull = () => {
          Promise.resolve()
            .then(() => fetch('/lifeguard/health', { cache: 'no-store' }))
            .then((response) => (response.ok ? response.json() : null))
            .then((payload) => {
              if (alive && payload && payload.enabled) setState(payload);
            })
            .catch(() => {
              /* endpoint missing means the feature is off; keep the last reading */
            });
        };
        pull();
        const timer = setInterval(pull, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      /* 圈始终在：读不到数据就显示占位，不做成消失。
       * 消失的指示器分不出「内存没事」和「指示器坏了」。
       * 读数保留最后一次，偶发失败不清屏。 */
      const known = Boolean(state) && Number.isFinite(state.pct);
      const pct = known ? state.pct : 0;
      const color = known ? (pct >= DANGER ? RED : pct >= WARN ? AMBER : 'inherit') : 'inherit';
      /* 数字跟着环一起退：低压淡，接近上限才实。 */
      const readout = !known ? 0.5 : pct >= DANGER ? 1 : pct >= WARN ? 0.8 : pct >= 50 ? 0.6 : 0.42;
      const style = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, lineHeight: 1, color, whiteSpace: 'nowrap', userSelect: 'none', opacity: known ? 1 : 0.5 };
      return h('span', { title: hintOf(known ? state : null), style }, h('span', { key: 'label', style: { opacity: 0.66 } }, '内存'), h(Ring, { key: 'ring', pct }), h('span', { key: 'pct', style: { fontVariantNumeric: 'tabular-nums', opacity: readout } }, known ? `${pct}%` : '–'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'lifeguard-health', order: 40 }, Health),
        );
      },
    };
  },
});
