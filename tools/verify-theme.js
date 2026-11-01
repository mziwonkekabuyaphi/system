const postcss = require('postcss'), fs = require('fs');
const report = JSON.parse(fs.readFileSync('/tmp/new/tools/theme-codemod-report.json','utf8'));
const unesc = s => s.replace(/\\(.)/g,'$1');

function load(file){
  const root = postcss.parse(fs.readFileSync(file,'utf8'));
  const vars = {}; root.walkDecls(d => { if (d.prop.startsWith('--color-')) vars[d.prop]=d.value; });
  const norm = v => { let p,n=0; do{p=v; v=v.replace(/var\((--color-[\w-]+)\)/g,(m,k)=>vars[k]??m); n++;}while(v!==p&&n<6);
    v=v.toLowerCase().replace(/\s+/g,' ');
    v=v.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/g,'#$1$2$3').replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g,'#$1$1$2$2$3$3'); // canonical 6-digit
    v=v.replace(/#([0-9a-f]{6})/g,'#$1');
    return v; };
  const out = {};
  root.walkRules(rule => {
    const m = rule.selector.match(/^\.((?:\\.|[\w-])+)$/) ; if (!m) return;          // top-level utility class rule
    if (rule.parent.type==='rule') return;
    const cls = unesc(m[1]); const items=[];
    const visit=(node,ctx)=>{ node.each(c=>{
      if (c.type==='decl') items.push(ctx.join(' > ')+' {'+c.prop+':'+norm(c.value)+'}');
      else if (c.type==='rule') visit(c,[...ctx, c.selector.split(m[1]).join('§').replace(/\s+/g,' ')]);
      else if (c.type==='atrule') visit(c,[...ctx,'@'+c.name+' '+c.params.replace(/\s+/g,' ')]);
    });};
    visit(rule,[]);
    (out[cls] ||= []).push(...items);
  });
  for (const k in out) out[k].sort();
  return out;
}
const OLD=load('/tmp/tw/old.out.css'), NEW=load('/tmp/tw/new.out.css');
const mixNorm = s => s.replace(/color-mix\(in (?:oklab|srgb|lab|oklch)/g,'color-mix(in X');   // see note: mixing with `transparent`

// New CSS = srgb fallback + the ORIGINAL oklab declaration under @supports(color-mix in lab).
// Every current browser applies the @supports block, so the effective style equals the old one.
const SUP='@supports (color: color-mix(in lab, red, red)) ';
function supportsOverride(oldItems, newItems){
  const S='@supports (color: color-mix(in lab, red, red))';
  const eff = newItems.filter(i=>i.includes(S)).map(i=>i.replace(' > '+S,'').replace(S,'').replace(/^ /,''));
  const o = oldItems.map(i=>i.replace(/^ /,'')).sort(), n = eff.sort();
  return o.length>0 && JSON.stringify(o)===JSON.stringify(n);
}
const pairs=new Map();
for (const r of report) { if (!/^(?:[\w-]+:)*(?:border-[trblxy]|ring-offset|border|bg|text|ring|divide|outline|decoration|placeholder|fill|stroke|from|via|to|accent|caret)-/.test(r.old)) continue; pairs.set(r.old+'=>'+r.new,[r.old,r.new]); }
let ok=0, okMixOnly=0, bad=[], missing=[], total=0;
for (const [,[o,nw]] of pairs) {
  const olds = Object.keys(OLD).filter(k=>k===o||k.endsWith(':'+o));
  if (!olds.length) { missing.push(o); continue; }
  for (const a of olds) {
    total++;
    const prefix = a===o ? '' : a.slice(0,a.length-o.length), b=prefix+nw;
    if (!NEW[b]) { bad.push([a,b,'no rule generated for new class']); continue; }
    const A=JSON.stringify(OLD[a]), B=JSON.stringify(NEW[b]);
    if (A===B) ok++;
    else if (supportsOverride(OLD[a], NEW[b])) okMixOnly++; else bad.push([a,b,A.slice(0,220)+'  VS  '+B.slice(0,220)]);
  }
}
console.log(`class pairs: ${pairs.size}  variant instances checked: ${total}`);
console.log(`identical: ${ok}   identical in every browser that supports color-mix (via @supports override): ${okMixOnly}   MISMATCH: ${bad.length}   not in old CSS: ${missing.length}`);
bad.slice(0,12).forEach(x=>console.log('MISMATCH',x[0],'->',x[1],'\n   ',x[2]));
if (missing.length) console.log('not found in old CSS (unused/variant-only):', missing.slice(0,8).join(' | '));
