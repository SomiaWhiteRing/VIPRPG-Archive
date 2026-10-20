import ts from 'typescript';

// Read the publisher's literal sample objects without evaluating site code.
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(e => literal(e as ts.Expression));
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) throw new Error('Non-literal source sample property');
    return [p.name.text, literal(p.initializer)];
  }));
  throw new Error('Non-literal source sample expression');
}

export function extract2020Sample(code: string) {
  const file = ts.createSourceFile('source.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const result: Record<string, unknown> = {};
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file);
      if (name === 'data_h.games.unshift' || name === 'data_s.games.unshift') {
        result[name === 'data_h.games.unshift' ? 'h' : 's'] = literal(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!result.h || !result.s) throw new Error('Source sample objects not found');
  return result;
}

export function rewrite2020Script(code: string, page: string) {
  const file = ts.createSourceFile(page, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const replace = (node: ts.Node, text: string) => edits.push({ start: node.getStart(file), end: node.end, text });
  const targets: Record<string, string> = { 'parent.location.href': 'root', 'parent.frame1.location.href': 'frame1', 'parent.frame2.location.href': 'frame2', 'location.href': 'frame2' };
  function visit(node: ts.Node) {
    if (page === 'menu.html' && ts.isFunctionDeclaration(node) && node.name?.text === 'entry' && node.body) {
      replace(node.body, "{archiveNavigate('frame2','archive-closed.html');}"); return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = targets[node.left.getText(file)];
      if (target) { replace(node, `archiveNavigate(${JSON.stringify(target)},${node.right.getText(file)})`); return; }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.getText(file);
      if (name === 'parent.location.search') { replace(node, 'location.search'); return; }
      if (name === 'location.origin' || name === 'window.location.origin') { replace(node, JSON.stringify('https://vipgw2020.tubakurame.com')); return; }
    }
    if (ts.isStringLiteral(node) && node.text.includes('/img/')) { replace(node, JSON.stringify(node.text.replace(/(?:\.\/|\/)img\//g, '/original-pages/2020-gw/img/'))); return; }
    if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.getText(file).includes('/img/')) {
      replace(node, node.getText(file).replace(/(?:\.\/|\/)img\//g, '/original-pages/2020-gw/img/')); return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const e of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  return code;
}

const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function snapshot2020Script(h: unknown, s: unknown) {
  return `
    var archiveSnapshots=${safeJson({h,s})};
    $.ajax=function(options){
      var u=new URL(options.url,location.href),data;
      if(u.pathname.endsWith('/games.json'))data=archiveSnapshots.s;
      else if(u.pathname.endsWith('/data_h_local.json')||u.href==='https://viprpg-gw2020.herokuapp.com/entries')data=archiveSnapshots.h;
      else{if(options.error)options.error({status:0},'offline');return;}
      if(options.success)options.success(JSON.parse(JSON.stringify(data)));
    };
    function archiveNavigate(target,value){
      var u=new URL(value,'https://vipgw2020.tubakurame.com/');
      if(u.origin==='https://vipgw2020.tubakurame.com'){
        var name=u.pathname.replace(/^\\//,'')||'index.html';
        if(!['index.html','menu.html','entries.html','top.html','about.html','update.html','past.html','entryFail.html','ab.html','archive-closed.html'].includes(name))return;
        parent.postMessage({type:'archive-2020-navigation',target:target,url:location.origin+'/original-pages/2020-gw/'+name+u.search+u.hash},'*');
      }else if(u.protocol==='http:'||u.protocol==='https:'){
        parent.postMessage({type:'archive-2020-navigation',target:'frame2',url:location.origin+'/original-pages/2020-gw/archive-external.html?url='+encodeURIComponent(u.href)},'*');
      }
    }
    addEventListener('click',function(event){
      var a=event.target.closest('a[href]');if(!a||a.getAttribute('href').startsWith('javascript:'))return;
      var u=new URL(a.href);
      if(u.origin==='https://vipgw2020.tubakurame.com'&&(u.pathname==='/'||u.pathname==='/index.html')){event.preventDefault();archiveNavigate('root',u.href);}
    });`;
}

export function root2020Script() {
  return `
    window.onload=function(){
      var query=location.search,num=new URLSearchParams(query).get('id');
      document.querySelector('frame[name="frame1"]').src='menu.html'+query;
      document.querySelector('frame[name="frame2"]').src=num!==null?'entries.html?id='+encodeURIComponent(num):'top.html';
    };
    addEventListener('message',function(event){
      var menu=document.querySelector('frame[name="frame1"]'),main=document.querySelector('frame[name="frame2"]');
      if(!menu||!main||![menu.contentWindow,main.contentWindow].includes(event.source)||event.data?.type!=='archive-2020-navigation')return;
      var u=new URL(event.data.url,location.href),dir=location.pathname.slice(0,location.pathname.lastIndexOf('/')+1);
      if(u.origin!==location.origin||!u.pathname.startsWith(dir))return;
      var name=u.pathname.slice(dir.length);
      if(!['index.html','menu.html','entries.html','top.html','about.html','update.html','past.html','entryFail.html','ab.html','archive-closed.html','archive-external.html'].includes(name))return;
      if(event.data.target==='root')location.href=u.href;
      else if(event.data.target==='frame1')menu.src=u.href;
      else if(event.data.target==='frame2')main.src=u.href;
    });`;
}
