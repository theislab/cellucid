import{F as Xr,G as Hr,t as Lo}from"./chunk.4RO35XQH.js";import{D as Oo,F as Ir,G as Dr,c as Lr,fa as jr,g as Pr,ga as Gr,j as zr,k as Ke,ka as Yr,na as Kr,ra as Po,s as Nr}from"./chunk.YG5GM5R2.js";import{b as so,c as Wr}from"./chunk.R3A3K4UN.js";import{e as Fo,f as Br,g as Ur}from"./chunk.4RPXNZAP.js";import{c as be}from"./chunk.IXWWWMZH.js";import{b as Te}from"./chunk.J6VZ5QYM.js";import{d as io,g as ve}from"./chunk.XB45ER7C.js";import{b as $o,i as pt,l as Fr}from"./chunk.AIHKJ5NY.js";import{a}from"./chunk.BLB2Q6XA.js";var qr=new Set(["orbit","planar","free"]),wa=Object.freeze(["navigationMode","orbit","freefly"]),va=Object.freeze(["radius","targetRadius","theta","phi","target"]),Ea=Object.freeze(["position","yaw","pitch"]);function zo(e,o){if(e===null||typeof e!="object"||Array.isArray(e)||Object.getPrototypeOf(e)!==Object.prototype)return!1;let t=0;for(let r in e)Object.hasOwn(e,r)&&t++;if(t!==o.length)return!1;for(let r=0;r<o.length;r++)if(!Object.prototype.propertyIsEnumerable.call(e,o[r]))return!1;return!0}a(zo,"hasExactKeys");function Vr(e){return Array.isArray(e)&&e.length===3&&Number.isFinite(e[0])&&Number.isFinite(e[1])&&Number.isFinite(e[2])}a(Vr,"isFiniteVec3");function vs(e){if(!qr.has(e))throw new RangeError(`Navigation mode must be exactly "orbit", "planar", or "free"; received ${String(e)}.`);return e}a(vs,"assertNavigationMode");function _a(e){if(!zo(e,wa)||!qr.has(e.navigationMode))return!1;let o=e.orbit,t=e.freefly;return!!(zo(o,va)&&Number.isFinite(o.radius)&&o.radius>0&&Number.isFinite(o.targetRadius)&&o.targetRadius>0&&Number.isFinite(o.theta)&&Number.isFinite(o.phi)&&Vr(o.target)&&zo(t,Ea)&&Vr(t.position)&&Number.isFinite(t.yaw)&&Number.isFinite(t.pitch))}a(_a,"isExactCameraState");function wt(e,o="Camera state"){if(!_a(e))throw new TypeError(`${o} must contain an exact navigationMode plus complete orbit and freefly state.`);return e}a(wt,"assertCameraState");function co(e,o="Camera state"){let t=wt(e,o);return{navigationMode:t.navigationMode,orbit:{radius:t.orbit.radius,targetRadius:t.orbit.targetRadius,theta:t.orbit.theta,phi:t.orbit.phi,target:[...t.orbit.target]},freefly:{position:[...t.freefly.position],yaw:t.freefly.yaw,pitch:t.freefly.pitch}}}a(co,"cloneCameraState");function Zr(e,o){return e[0]===o[0]&&e[1]===o[1]&&e[2]===o[2]}a(Zr,"sameVec3");function Es(e,o){let t=wt(e,"Compared camera state"),r=wt(o,"Compared camera state");return t.navigationMode!==r.navigationMode||!Zr(t.orbit.target,r.orbit.target)?!1:t.navigationMode==="free"?Zr(t.freefly.position,r.freefly.position)&&t.freefly.yaw===r.freefly.yaw&&t.freefly.pitch===r.freefly.pitch:t.orbit.radius===r.orbit.radius&&t.orbit.targetRadius===r.orbit.targetRadius&&t.orbit.theta===r.orbit.theta&&t.orbit.phi===r.orbit.phi}a(Es,"cameraStatesHaveSamePose");var Aa=3,Ma=Math.PI/4,Ta=Math.PI/4;function _s(){let e=Aa,o=Ma,t=Ta,r=[0,0,0],n=[e*Math.sin(t)*Math.cos(o),e*Math.cos(t),e*Math.sin(t)*Math.sin(o)],i=[r[0]+n[0],r[1]+n[1],r[2]+n[2]],c=[-n[0]/e,-n[1]/e,-n[2]/e];return{orbit:{radius:e,theta:o,phi:t,target:r},freefly:{position:i,yaw:Math.atan2(c[2],c[0]),pitch:Math.asin(c[1])}}}a(_s,"createDefaultCameraPose");var Ge=Object.freeze({base:1,ratio:5,fadeInFraction:.6}),Do=Object.freeze({floor:Object.freeze({minCellCssPx:22,maxFamilySpacing:2.5}),backdrop:Object.freeze({minCellCssPx:16,maxFamilySpacing:1/0})}),mt=Object.freeze({lineWidthCssPx:1,majorLineWidthCssPx:1,dotRadiusCssPx:1.05,majorDotRadiusCssPx:1.3}),De=Object.freeze({floorClearance:.12,innerRadius:2.6,outerRadius:8.5,grazingFadeStart:.035,grazingFadeEnd:.2,clearanceFade:.06,poolReach:1.8,poolRoundness:.4}),Ts=.3,Bo=Object.freeze({studio:Object.freeze({surface:Object.freeze([236,236,236]),glow:Object.freeze([246,246,246]),ink:Object.freeze([96,96,96]),lineMinorAlpha:.15,lineMajorAlpha:.28,dotMinorAlpha:.32,dotMajorAlpha:.42,poolAlpha:.09}),"studio-dark":Object.freeze({surface:Object.freeze([17,17,17]),glow:Object.freeze([27,27,27]),ink:Object.freeze([200,200,200]),lineMinorAlpha:.12,lineMajorAlpha:.22,dotMinorAlpha:.26,dotMajorAlpha:.34,poolAlpha:.09})});function Ut(e){return[e[0]/255,e[1]/255,e[2]/255]}a(Ut,"studioColor01");function vt(e,o,t){let r=Math.max(0,Math.min(1,(t-e)/(o-e)));return r*r*(3-2*r)}a(vt,"smoothstep");function Sa(e,o,t){let r=e.minCellCssPx,n=e.maxFamilySpacing;return{presence:vt(r*Ge.fadeInFraction,r,t)*(n===1/0?1:1-vt(n*.5,n,o)),majorness:vt(r,r*Ge.ratio,t)}}a(Sa,"studioFamilyWeights");function Uo(e){return Ge.base*Ge.ratio**e}a(Uo,"studioFamilySpacing");function Jr(e,o,t){return Math.floor(Math.log(o*e.minCellCssPx*t/Ge.base)/Math.log(Ge.ratio))}a(Jr,"studioFamilyLevel");function jo({surface:e,coarsestLevel:o,level:t,footprint:r,pixelRatio:n,minorAlpha:i,majorAlpha:c}){let s=0,l=0;for(let h=t;h<=Math.min(o,t+2);h++){let d=Uo(h),u=Sa(e,d,d/r/n),m=u.presence*(i+(c-i)*u.majorness);m>s&&(s=m,l=u.majorness)}return{strength:s,majorness:l}}a(jo,"studioMarkStrength");function lo(e){return 1-vt(0,1,e)}a(lo,"studioFalloff");function Qr(e){return 1-vt(De.innerRadius,De.outerRadius,e)}a(Qr,"studioStageFade");function fo(e){return vt(De.grazingFadeStart,De.grazingFadeEnd,e)}a(fo,"studioGrazingFade");function uo(e){return vt(0,De.clearanceFade,e)}a(uo,"studioClearanceFade");function Ss(e,o){return e<3||o==="planar"?1:0}a(Ss,"studioSurfacePlanarity");function en(e,o){return o.floor=1-e,o.backdrop=e,o}a(en,"resolveStudioSurfaceWeights");function ks(e,o,t){let r=e===null?-1:e.min[1];return t.floorY=r-De.floorClearance,t.flat=o<3,t.stageX=e===null?0:(e.min[0]+e.max[0])*.5,t.stageZ=e===null?0:(e.min[2]+e.max[2])*.5,t.centerY=e===null?0:(e.min[1]+e.max[1])*.5,t.extentX=e===null?1:(e.max[0]-e.min[0])*.5,t.extentY=e===null?1:(e.max[1]-e.min[1])*.5,t.extentZ=e===null?1:(e.max[2]-e.min[2])*.5,t}a(ks,"resolveStudioPaneGeometry");function tn(e,o,t){if(o.flat)return t.normalX=0,t.normalY=0,t.normalZ=-1,t.offset=-o.stageZ,t.uX=1,t.uY=0,t.uZ=0,t.vX=0,t.vY=1,t.vZ=0,t;let r=-e[2],n=-e[6],i=-e[10],c=o.extentX*Math.abs(r)+o.extentY*Math.abs(n)+o.extentZ*Math.abs(i)+De.floorClearance;return t.normalX=r,t.normalY=n,t.normalZ=i,t.offset=r*o.stageX+n*o.centerY+i*o.stageZ+c,t.uX=e[0],t.uY=e[4],t.uZ=e[8],t.vX=e[1],t.vY=e[5],t.vZ=e[9],t}a(tn,"resolveStudioBackdropPlane");function No(e,o,t,r,n){let i=e[3]*o+e[7]*t+e[11]*r+e[15];return i>1e-9?(n[0]=(e[0]*o+e[4]*t+e[8]*r+e[12])/i,n[1]=(e[1]*o+e[5]*t+e[9]*r+e[13])/i,!0):!1}a(No,"projectToNdc");var Io=[0,0],kt=[0,0];function on(e,o,t,r){r.gate=0;let n=o[1]-t.floorY,i=Math.hypot(o[0]-t.stageX,n,o[2]-t.stageZ);if(!(n>0)||!(i>0))return r;let c=uo(n)*fo(n/i);if(!(c>0))return r;let s=Math.max(t.extentX,t.extentZ)*De.poolRoundness,l=Math.max(t.extentX,s)*De.poolReach,h=Math.max(t.extentZ,s)*De.poolReach;if(!(l>0)||!(h>0))return r;let d=t.floorY;if(!No(e,t.stageX,d,t.stageZ,Io)||(r.centerX=Io[0],r.centerY=Io[1],!No(e,t.stageX+l,d,t.stageZ,kt))||(r.axisAX=kt[0]-r.centerX,r.axisAY=kt[1]-r.centerY,!No(e,t.stageX,d,t.stageZ+h,kt)))return r;r.axisBX=kt[0]-r.centerX,r.axisBY=kt[1]-r.centerY;let u=r.axisAX*r.axisBY-r.axisBX*r.axisAY;return Math.abs(u)>1e-9&&(r.gate=c),r}a(on,"resolveStudioPool");var rn=Object.freeze(["white","grid","studio","atelier","abyss","aurora","black","grid-dark","studio-dark","nebula","abyss-dark","aurora-dark"]),$s=Object.freeze([Object.freeze({label:"Light",backgrounds:Object.freeze(["white","grid","studio","atelier","abyss","aurora"])}),Object.freeze({label:"Dark",backgrounds:Object.freeze(["black","grid-dark","studio-dark","nebula","abyss-dark","aurora-dark"])})]);var ka=Object.freeze({white:"White",grid:"Grid (light)",studio:"Studio (light)",atelier:"Atelier (light)",abyss:"Abyss (light)",aurora:"Aurora (light)",black:"Black","grid-dark":"Grid (dark)","studio-dark":"Studio (dark)",nebula:"Nebula (dark)","abyss-dark":"Abyss (dark)","aurora-dark":"Aurora (dark)"}),nn=Object.freeze(["studio","studio-dark"]),an=Object.freeze(["atelier","abyss","aurora","nebula","abyss-dark","aurora-dark"]),Os=Object.freeze(["grid","grid-dark"]),sn=`Viewer background must be exactly one of ${rn.map(e=>`"${e}"`).join(", ")}.`;function ho(e){return rn.includes(e)}a(ho,"isViewerBackground");var ct=Object.freeze({atelier:Object.freeze({id:"atelier",family:"atelier",program:"atelier",tone:"light",label:"Atelier (light)",surface:Object.freeze([238,235,230]),defaultTints:Object.freeze([Object.freeze([.55,.52,.48]),Object.freeze([.5,.52,.56]),Object.freeze([.52,.5,.5])])}),nebula:Object.freeze({id:"nebula",family:"atelier",program:"nebula",tone:"dark",label:"Nebula (dark)",surface:Object.freeze([7,8,14]),defaultTints:Object.freeze([Object.freeze([.36,.42,.95]),Object.freeze([.85,.32,.62]),Object.freeze([.2,.75,.8])])}),abyss:Object.freeze({id:"abyss",family:"abyss",program:"abyss",tone:"light",label:"Abyss (light)",surface:Object.freeze([214,234,234]),defaultTints:Object.freeze([Object.freeze([.2,.7,.75]),Object.freeze([.3,.55,.85]),Object.freeze([.55,.8,.6])])}),"abyss-dark":Object.freeze({id:"abyss-dark",family:"abyss",program:"abyss",tone:"dark",label:"Abyss (dark)",surface:Object.freeze([3,14,21]),defaultTints:Object.freeze([Object.freeze([.15,.85,.85]),Object.freeze([.25,.55,1]),Object.freeze([.45,1,.7])])}),aurora:Object.freeze({id:"aurora",family:"aurora",program:"aurora",tone:"light",label:"Aurora (light)",surface:Object.freeze([236,234,236]),defaultTints:Object.freeze([Object.freeze([1,.72,.55]),Object.freeze([.62,.72,.95]),Object.freeze([.95,.65,.75])])}),"aurora-dark":Object.freeze({id:"aurora-dark",family:"aurora",program:"aurora",tone:"dark",label:"Aurora (dark)",surface:Object.freeze([6,10,22]),defaultTints:Object.freeze([Object.freeze([.25,1,.6]),Object.freeze([.65,.35,1]),Object.freeze([.2,.8,.95])])})}),Ps=Object.freeze(Object.keys(ct));function Rt(e){return typeof e=="string"&&Object.prototype.hasOwnProperty.call(ct,e)}a(Rt,"isBackdropLook");function ln(e){let o=ct[e].surface;return[o[0]/255,o[1]/255,o[2]/255]}a(ln,"backdropLookSurface01");function Go(e){return e<=.04045?e/12.92:((e+.055)/1.055)**2.4}a(Go,"srgbToLinear");function cn(e){return .2126*e[0]+.7152*e[1]+.0722*e[2]}a(cn,"linearLuminance");function Xo(e,o,t=[0,0,0]){let r=[Go(e[0]),Go(e[1]),Go(e[2])],n=Math.max(cn(r),1e-4);for(let c=0;c<3;c++){let s=r[c]/n;t[c]=1+(s-1)*o}let i=Math.max(cn(t),1e-4);for(let c=0;c<3;c++)t[c]=Math.max(0,t[c]/i);return t}a(Xo,"shapeBackdropTint");function fn(e,o,t=3,r=65536){let n=Math.floor(e.length/4),i=new Float32Array(32768),c=new Float32Array(32768*3),s=Math.max(1,Math.floor(n/r)),l=0;for(let u=0;u<n;u+=s){if(o!==null&&o[u]===0)continue;let m=e[u*4],A=e[u*4+1],y=e[u*4+2],b=Math.max(m,A,y),T=Math.min(m,A,y),g=.15+(b-T)/255,w=m>>3<<10|A>>3<<5|y>>3;i[w]+=g,c[w*3]+=m*g,c[w*3+1]+=A*g,c[w*3+2]+=y*g,l+=1}let h=[],d=[];for(let u=0;u<t;u++){let m=-1,A=0;for(let w=0;w<32768;w++)i[w]>A&&(A=i[w],m=w);if(m<0)break;let y=i[m];h.push([c[m*3]/y/255,c[m*3+1]/y/255,c[m*3+2]/y/255]),d.push(y);let b=m>>10,T=m>>5&31,_=m&31,g=5;for(let w=Math.max(0,b-g);w<=Math.min(31,b+g);w++)for(let C=Math.max(0,T-g);C<=Math.min(31,T+g);C++)for(let E=Math.max(0,_-g);E<=Math.min(31,_+g);E++)i[w<<10|C<<5|E]=0}return{colors:h,weights:d,sampled:l}}a(fn,"extractDominantColors");var jt=512,Ct=Object.freeze((()=>{let e=[-.42,1,.38],o=Math.hypot(e[0],e[1],e[2]);return e.map(t=>t/o)})());var Gt=.32;var Ra="background-select",un=2,dn=Object.freeze({grid:Object.freeze({kind:"grid",mode:"grid",opacity:.85,spacing:.2,lineWidth:.01,size:un,lineColor:Object.freeze([.56,.56,.57]),surfaceColor:Object.freeze([.965,.965,.97]),axisColors:Object.freeze({x:Object.freeze([.48,.46,.46]),y:Object.freeze([.46,.48,.46]),z:Object.freeze([.46,.46,.48])})}),"grid-dark":Object.freeze({kind:"grid",mode:"grid-dark",opacity:.75,spacing:.2,lineWidth:.008,size:un,lineColor:Object.freeze([.38,.38,.42]),surfaceColor:Object.freeze([.08,.09,.1]),axisColors:Object.freeze({x:Object.freeze([.62,.58,.58]),y:Object.freeze([.58,.62,.58]),z:Object.freeze([.58,.58,.62])})}),...Object.fromEntries(nn.map(e=>[e,Object.freeze({kind:"studio",mode:e,palette:Bo[e],surfaceColor:Object.freeze(Ut(Bo[e].surface))})])),...Object.fromEntries(an.map(e=>[e,Object.freeze({kind:"look",mode:e,surfaceColor:Object.freeze(ln(e))})]))});function hn(e){if(e===null||typeof e!="object"||typeof e.getElementById!="function")return null;let o=e.getElementById(Ra);return o===null||typeof o!="object"||typeof o.value!="string"?null:ho(o.value)?o.value:null}a(hn,"readActiveViewerBackground");function Ca(e){return e===null?null:dn[e]??null}a(Ca,"readReferenceGridAppearance");function Us(e){return Ca(hn(e))}a(Us,"readActiveReferenceGridAppearance");function pn(e,o){if(e===null)return null;if(!Object.values(dn).includes(e))throw new TypeError(`${o} must be null or a published viewer reference-layer appearance.`);return e}a(pn,"assertReferenceGridAppearance");function js(e){return hn(e)!==null?[]:[{title:"Active viewer background unavailable",detail:"The background control could not be read, so whether the viewer is drawing a reference layer — and which one, in which theme — cannot be confirmed. Reload the page and export again."}]}a(js,"buildViewerBackgroundFidelityWarnings");var $a=new Set(["png","svg"]),Oa=new Set(["full-vector","optimized-vector","hybrid"]),Fa=new Set(["right","bottom"]),La=new Set(["viewer","white","transparent","custom"]),Pa=new Set(Dr),Yo=Object.freeze(["axisLabelFontSizePx","background","backgroundColor","centroidLabelFontSizePx","crop","depthSort3d","emphasizeSelection","exportAllViews","fontFamily","fontSizePx","height","includeAxes","includeLegend","legendFontSizePx","legendPosition","optimizedTargetCount","referenceGrid","selectionMutedOpacity","showOrientation","signal","strategy","tickFontSizePx","title","titleFontSizePx","width","xLabel","yLabel"]),za=Object.freeze([...Yo,"dpi","format"].sort()),Na=Object.freeze([...Yo,"jobs"].sort()),Ia=Object.freeze(["dpi","format"]),Da=Object.freeze(["dpi","format","height","meta","options","selection","title","views","width"]),bn=Object.freeze(Yo.filter(e=>e!=="exportAllViews"&&e!=="signal").sort()),Ba=Object.freeze(["cameraState","data","id","label","renderState","scientificState"]),Ua=Object.freeze(["centroidColors","centroidFlags","centroidLabelTexts","centroidPositions","colors","pointCount","positions","transparency"]),ja=Object.freeze(["labels","points"]),Ga=Object.freeze(["highlightArray","totalCount","visibleCount"]),Xa=Object.freeze(["datasetGeneration","dimensionLevel","drawOrder","fieldKey","fieldKind","filters","geometryGeneration","legendModel","lodMembership","lodSizeMultiplier","normTransform","pointLayers"]),Ha=Object.freeze(["fieldKey","fieldKind","filters","id","label"]),Wa=Object.freeze(["center","scale"]),Ya=Object.freeze(["antialias","backdrop","bgColor","cameraDistance","cameraPosition","far","fogColor","fogDensity","fogFar","fogNear","fov","lightDir","lightingStrength","modelMatrix","mvpMatrix","near","pointSize","projectionMatrix","shaderQuality","sizeAttenuation","viewMatrix","viewportHeight","viewportWidth"]),Ka=Object.freeze(["centerY","extentX","extentY","extentZ","flat","floorY","glowCenterX","look","pixelRatio","planarity","stageX","stageZ"]),Va=Object.freeze(["ambient","id","shadow","time","tints"]),Za=Object.freeze(["packed","size","window"]);function qa(e,o){if(e!==null){if(ve(e,Va,o),!Rt(e.id))throw new TypeError(`${o}.id must name a background look.`);if(!Array.isArray(e.tints)||e.tints.length!==3)throw new TypeError(`${o}.tints must be three colours.`);if(e.tints.forEach((t,r)=>{if(!Array.isArray(t)||t.length!==3)throw new TypeError(`${o}.tints[${r}] must be an RGB triple.`);t.forEach((n,i)=>Ve(n,`${o}.tints[${r}][${i}]`,0))}),Ve(e.time,`${o}.time`,0),e.ambient!==0&&e.ambient!==1)throw new TypeError(`${o}.ambient must be exactly 0 or 1.`);if(e.shadow!==null){if(ve(e.shadow,Za,`${o}.shadow`),!Number.isSafeInteger(e.shadow.size)||e.shadow.size<=0)throw new TypeError(`${o}.shadow.size must be a positive integer.`);if(!(e.shadow.packed instanceof Uint16Array)||e.shadow.packed.length!==e.shadow.size*e.shadow.size*2)throw new TypeError(`${o}.shadow.packed must be the size² × 2 half-float map.`);if(!Array.isArray(e.shadow.window)||e.shadow.window.length!==3)throw new TypeError(`${o}.shadow.window must be [centre u, centre v, half size].`);e.shadow.window.forEach((t,r)=>Ve(t,`${o}.shadow.window[${r}]`))}}}a(qa,"assertBackdropLook");function Et(e,o,{allowEmpty:t=!0}={}){if(typeof e!="string"||!t&&e.trim().length===0)throw new TypeError(`${o} must be ${t?"a string":"a non-empty string"}.`)}a(Et,"assertString");function bt(e,o){if(typeof e!="boolean")throw new TypeError(`${o} must be an exact boolean.`)}a(bt,"assertBoolean");function Ko(e,o){let t=globalThis.AbortSignal,r=typeof t=="function"?Object.getOwnPropertyDescriptor(t.prototype,"aborted")?.get:null;if(e===null||typeof e!="object"||typeof r!="function"||typeof e.addEventListener!="function"||typeof e.removeEventListener!="function")throw new TypeError(`${o} must be an AbortSignal.`);try{return r.call(e)}catch{throw new TypeError(`${o} must be an AbortSignal.`)}}a(Ko,"readFigureExportAbortState");function xn(e,o="Figure export signal"){return Ko(e,o),e}a(xn,"assertFigureExportSignal");function mn(e){return e===null?!1:Ko(e,"Figure export signal")}a(mn,"isFigureExportSignalAborted");function Ja(e){if(e!==null&&Ko(e,"Figure export signal"))throw Fo(e)}a(Ja,"throwIfFigureExportAborted");function ec(e,o){return e===null?Promise.resolve(o):(xn(e),Ja(e),new Promise((t,r)=>{let n=!1,i=a(()=>{},"stopListening"),c=a((l,h)=>{n||(n=!0,i(),l(h))},"settle"),s=a(()=>c(r,Fo(e)),"settleAborted");i=Ur(e,s),Promise.resolve(o).then(l=>{mn(e)?s():c(t,l)},l=>{mn(e)?s():c(r,l)})}))}a(ec,"awaitFigureExportAbortable");function Re(e,o,t,r=1/0){if(!Number.isSafeInteger(e)||e<t||e>r)throw new RangeError(`${o} must be a safe integer from ${t} through ${r}.`)}a(Re,"assertInteger");function Ve(e,o,t=-1/0,r=1/0){if(typeof e!="number"||!Number.isFinite(e)||e<t||e>r)throw new RangeError(`${o} must be a finite number from ${t} through ${r}.`)}a(Ve,"assertFiniteNumber");function mo(e,o){if(!$a.has(e))throw new TypeError(`${o} must be exactly "svg" or "png".`)}a(mo,"assertFormat");function yn(e,o){if(Re(e.width,`${o}.width`,10),Re(e.height,`${o}.height`,10),bt(e.exportAllViews,`${o}.exportAllViews`),Et(e.title,`${o}.title`),bt(e.includeAxes,`${o}.includeAxes`),bt(e.includeLegend,`${o}.includeLegend`),!Fa.has(e.legendPosition))throw new TypeError(`${o}.legendPosition must be "right" or "bottom".`);if(Et(e.xLabel,`${o}.xLabel`),Et(e.yLabel,`${o}.yLabel`),!La.has(e.background))throw new TypeError(`${o}.background is not a current export background.`);if(typeof e.backgroundColor!="string"||!/^#[0-9a-fA-F]{6}$/.test(e.backgroundColor))throw new TypeError(`${o}.backgroundColor must be an exact #RRGGBB color.`);Et(e.fontFamily,`${o}.fontFamily`,{allowEmpty:!1});for(let t of["fontSizePx","legendFontSizePx","tickFontSizePx","axisLabelFontSizePx","titleFontSizePx","centroidLabelFontSizePx"])Re(e[t],`${o}.${t}`,1);return so(e.crop),pn(e.referenceGrid,`${o}.referenceGrid`),bt(e.showOrientation,`${o}.showOrientation`),bt(e.depthSort3d,`${o}.depthSort3d`),bt(e.emphasizeSelection,`${o}.emphasizeSelection`),Ve(e.selectionMutedOpacity,`${o}.selectionMutedOpacity`,0,1),e}a(yn,"assertBaseRequestValues");function gn(e,o,t){return ve(e,o,t),xn(e.signal,`${t}.signal`),yn(e,t)}a(gn,"assertBaseRequest");function Vo(e,o,t){if(!o){if(e.strategy!==null)throw new TypeError(`${t}.strategy must be null for PNG-only export.`);if(e.optimizedTargetCount!==null)throw new TypeError(`${t}.optimizedTargetCount must be null for PNG-only export.`);return}if(!Oa.has(e.strategy))throw new TypeError(`${t}.strategy must be one explicit current SVG export strategy.`);if(e.strategy==="optimized-vector"){Re(e.optimizedTargetCount,`${t}.optimizedTargetCount`,1e3,5e6);return}if(e.optimizedTargetCount!==null)throw new TypeError(`${t}.optimizedTargetCount must be null unless strategy is "optimized-vector".`)}a(Vo,"assertStrategyContract");function Qa(e,o){if(ve(e,Ia,o),mo(e.format,`${o}.format`),e.format==="png")Re(e.dpi,`${o}.dpi`,72);else if(e.dpi!==null)throw new TypeError(`${o}.dpi must be null for SVG export.`)}a(Qa,"assertJob");function tc(e){if(gn(e,za,"Figure export request"),mo(e.format,"Figure export request.format"),e.format==="png")Re(e.dpi,"Figure export request.dpi",72);else if(e.dpi!==null)throw new TypeError("Figure export request.dpi must be null for SVG export.");return Vo(e,e.format==="svg","Figure export request"),e}a(tc,"assertFigureExportSingleRequest");function oc(e){if(gn(e,Na,"Figure export batch request"),!Array.isArray(e.jobs)||e.jobs.length===0)throw new TypeError("Figure export batch request.jobs must be a non-empty array.");let o=new Set;return e.jobs.forEach((t,r)=>{Qa(t,`Figure export batch request.jobs[${r}]`);let n=t.format==="png"?`png:${t.dpi}`:"svg";if(o.has(n))throw new Error(`Duplicate figure export job "${n}".`);o.add(n)}),Vo(e,e.jobs.some(t=>t.format==="svg"),"Figure export batch request"),e}a(oc,"assertFigureExportBatchRequest");function ei(e,o="Figure export view id"){return Et(e,o,{allowEmpty:!1}),e}a(ei,"assertFigureExportViewId");function Ho(e,o,t,{checkValues:r=!0}={}){if(!(e instanceof Float32Array)||e.length!==o)throw new TypeError(`${t} must be a Float32Array of length ${o}.`);if(r){for(let n of e)if(!Number.isFinite(n))throw new TypeError(`${t} must contain only finite numbers.`)}}a(Ho,"assertFloat32Array");function po(e,o,t){if(!(e instanceof Uint8Array)||e.length!==o)throw new TypeError(`${t} must be a Uint8Array of length ${o}.`)}a(po,"assertUint8Array");function Wo(e,o,t=new Set){if(!(e===null||typeof e=="string"||typeof e=="boolean")){if(typeof e=="number"){Ve(e,o);return}if(typeof e!="object"||t.has(e))throw new TypeError(`${o} must contain only acyclic, owned legend data.`);if(!(e instanceof Uint8Array)){if(t.add(e),Array.isArray(e)){let r=Reflect.ownKeys(e);if(r.length!==e.length+1||!r.includes("length"))throw new TypeError(`${o} must be one dense array without custom properties.`);for(let n=0;n<e.length;n++){if(!Object.hasOwn(e,n))throw new TypeError(`${o} must not contain sparse entries.`);Wo(e[n],`${o}[${n}]`,t)}t.delete(e);return}io(e,o);for(let r of Reflect.ownKeys(e)){let n=Object.getOwnPropertyDescriptor(e,r);if(typeof r!="string"||n===void 0||n.enumerable!==!0||!Object.hasOwn(n,"value"))throw new TypeError(`${o} must contain only enumerable string data properties.`);Wo(n.value,`${o}.${r}`,t)}t.delete(e)}}}a(Wo,"assertOwnedLegendValue");function ti(e,o){if(ve(e,Ka,o),typeof e.flat!="boolean")throw new TypeError(`${o}.flat must be an exact boolean.`);for(let t of["centerY","floorY","stageX","stageZ"])Ve(e[t],`${o}.${t}`);for(let t of["extentX","extentY","extentZ"])Ve(e[t],`${o}.${t}`,0);if(Ve(e.glowCenterX,`${o}.glowCenterX`,-1,1),Ve(e.pixelRatio,`${o}.pixelRatio`,Number.MIN_VALUE),e.planarity!==0&&e.planarity!==1)throw new TypeError(`${o}.planarity must be exactly 0 or 1.`);qa(e.look,`${o}.look`)}a(ti,"assertBackdrop");function oi(e,o){ve(e,Ya,o),ti(e.backdrop,`${o}.backdrop`);for(let t of["mvpMatrix","viewMatrix","modelMatrix","projectionMatrix"])Ho(e[t],16,`${o}.${t}`);for(let t of["fogColor","bgColor","lightDir"])Ho(e[t],3,`${o}.${t}`);if(!Array.isArray(e.cameraPosition)||e.cameraPosition.length!==3)throw new TypeError(`${o}.cameraPosition must be a three-number array.`);e.cameraPosition.forEach((t,r)=>{Ve(t,`${o}.cameraPosition[${r}]`)});for(let t of["pointSize","sizeAttenuation","fov","near","far","lightingStrength","fogDensity","fogNear","fogFar","cameraDistance"])Ve(e[t],`${o}.${t}`);if(Re(e.viewportWidth,`${o}.viewportWidth`,1),Re(e.viewportHeight,`${o}.viewportHeight`,1),typeof e.antialias!="boolean")throw new TypeError(`${o}.antialias must be an exact boolean.`);if(!Pa.has(e.shaderQuality))throw new TypeError(`${o}.shaderQuality is not a current shader quality.`);if(e.fogNear<0||e.fogFar<e.fogNear)throw new RangeError(`${o} fog range must satisfy 0 <= fogNear <= fogFar.`)}a(oi,"assertRenderState");function ri(e,o,t){ve(e,Ua,t),Re(e.pointCount,`${t}.pointCount`,0),Re(o,`${t} dimensionLevel`,1,3),Ho(e.positions,e.pointCount*o,`${t}.positions`,{checkValues:!1}),po(e.colors,e.pointCount*4,`${t}.colors`),po(e.transparency,e.pointCount,`${t}.transparency`),ve(e.centroidFlags,ja,`${t}.centroidFlags`),bt(e.centroidFlags.points,`${t}.centroidFlags.points`),bt(e.centroidFlags.labels,`${t}.centroidFlags.labels`);let r=[e.centroidPositions,e.centroidColors].map(i=>i!==null);if(r[0]!==r[1])throw new TypeError(`${t} centroid positions and colors must both be present or both be null.`);let n=0;if(r[0]){if(!(e.centroidPositions instanceof Float32Array)||e.centroidPositions.length%3!==0)throw new TypeError(`${t}.centroidPositions must contain xyz triplets.`);n=e.centroidPositions.length/3,po(e.centroidColors,n*4,`${t}.centroidColors`)}if(!Array.isArray(e.centroidLabelTexts)||e.centroidLabelTexts.some(i=>typeof i!="string"))throw new TypeError(`${t}.centroidLabelTexts must be an array of strings.`);if(e.centroidFlags.labels&&e.centroidLabelTexts.length!==n)throw new Error(`${t}.centroidLabelTexts must match the published centroid count when labels are enabled.`)}a(ri,"assertViewData");function ni(e,o,t){if(ve(e,Ga,t),Re(e.totalCount,`${t}.totalCount`,0,o),Re(e.visibleCount,`${t}.visibleCount`,0,e.totalCount),e.totalCount===0){if(e.highlightArray!==null)throw new TypeError(`${t}.highlightArray must be null when no cells are highlighted.`);return}po(e.highlightArray,o,`${t}.highlightArray`)}a(ni,"assertSelectionSnapshot");function ai(e,o,t){if(ve(e,Xa,t),Re(e.datasetGeneration,`${t}.datasetGeneration`,0),Re(e.dimensionLevel,`${t}.dimensionLevel`,1,3),Re(e.geometryGeneration,`${t}.geometryGeneration`,1),e.fieldKey!==null&&typeof e.fieldKey!="string")throw new TypeError(`${t}.fieldKey must be a string or null.`);if(e.fieldKind!==null&&typeof e.fieldKind!="string")throw new TypeError(`${t}.fieldKind must be a string or null.`);if(e.fieldKey===null!=(e.fieldKind===null))throw new TypeError(`${t} field key and kind describe one field and must be published together.`);if(!Array.isArray(e.filters)||e.filters.some(r=>typeof r!="string"))throw new TypeError(`${t}.filters must be an array of strings.`);if(e.legendModel!==null&&(io(e.legendModel,`${t}.legendModel`),Wo(e.legendModel,`${t}.legendModel`)),Yr(e.lodMembership,{pointCount:o.pointCount,dimensionLevel:e.dimensionLevel,label:`${t}.lodMembership`}),Kr(e.drawOrder,{pointCount:o.pointCount,label:`${t}.drawOrder`}),Ve(e.lodSizeMultiplier,`${t}.lodSizeMultiplier`,Number.MIN_VALUE),e.pointLayers===null||typeof e.pointLayers!="object"||!(Number.isFinite(e.pointLayers.readScale)&&e.pointLayers.readScale>=1)||typeof e.pointLayers.readEveryLevel!="boolean")throw new TypeError(`${t}.pointLayers must be {readScale >= 1, readEveryLevel}.`);if(ve(e.normTransform,Wa,`${t}.normTransform`),!Array.isArray(e.normTransform.center)||e.normTransform.center.length!==3)throw new TypeError(`${t}.normTransform.center must be a three-number array.`);e.normTransform.center.forEach((r,n)=>{Ve(r,`${t}.normTransform.center[${n}]`)}),Ve(e.normTransform.scale,`${t}.normTransform.scale`,Number.MIN_VALUE)}a(ai,"assertScientificState");function ii(e,o){if(io(e,"Figure export payload.meta"),!Array.isArray(e.views)||e.views.length!==o.length)throw new TypeError("Figure export payload.meta.views must publish one record per exported view.");e.views.forEach((t,r)=>{let n=`Figure export payload.meta.views[${r}]`;ve(t,Ha,n);let i=o[r];if(t.id!==i.id||t.label!==i.label)throw new Error(`${n} must describe the exported view "${i.id}".`);let c=i.scientificState;if(t.fieldKey!==c.fieldKey||t.fieldKind!==c.fieldKind)throw new Error(`${n} must name the field its view was coloured by.`);if(!Array.isArray(t.filters)||t.filters.length!==c.filters.length||t.filters.some((s,l)=>s!==c.filters[l]))throw new Error(`${n} must publish exactly its view's filters.`)})}a(ii,"assertMetaProvenance");function si(e,o){ve(e,bn,o);let t={...e,exportAllViews:!1};yn(t,o)}a(si,"assertPayloadOptions");function rc(e){if(ve(e,Da,"Figure export payload"),mo(e.format,"Figure export payload.format"),Re(e.width,"Figure export payload.width",10),Re(e.height,"Figure export payload.height",10),e.format==="png")Re(e.dpi,"Figure export payload.dpi",72);else if(e.dpi!==null)throw new TypeError("Figure export payload.dpi must be null for SVG export.");if(Et(e.title,"Figure export payload.title"),si(e.options,"Figure export payload.options"),Vo(e.options,e.format==="svg","Figure export payload.options"),!Array.isArray(e.views)||e.views.length===0)throw new TypeError("Figure export payload.views must be a non-empty array.");let o=e.views[0]?.data?.pointCount;Re(o,"Figure export payload point count",0),ni(e.selection,o,"Figure export payload.selection");let t=new Set;return e.views.forEach((r,n)=>{let i=`Figure export payload.views[${n}]`;if(ve(r,Ba,i),ei(r.id,`${i}.id`),Et(r.label,`${i}.label`,{allowEmpty:!1}),t.has(r.id))throw new Error(`Figure export payload contains duplicate view "${r.id}".`);if(t.add(r.id),ri(r.data,r.scientificState?.dimensionLevel,`${i}.data`),r.data.pointCount!==o)throw new RangeError(`${i}.data.pointCount must match every exported view.`);oi(r.renderState,`${i}.renderState`),wt(r.cameraState,`${i}.cameraState`),ai(r.scientificState,r.data,`${i}.scientificState`)}),ii(e.meta,e.views),e}a(rc,"assertFigureExportPayload");function nc(e,o){mo(o,"Figure export payload format");let t={};for(let r of bn)t[r]=e[r];return o==="png"&&(t.strategy=null,t.optimizedTargetCount=null),Object.freeze(t)}a(nc,"createFigureExportPayloadOptions");function ci(e){return!Number.isFinite(e)||e<0?0:e>1?1:e}a(ci,"clamp01");function Zo(e){return Math.max(0,Math.min(255,Math.round(ci(e)*255))).toString(16).padStart(2,"0")}a(Zo,"toHexByte");function lt(e){return!e||e.length<3?null:`#${Zo(e[0])}${Zo(e[1])}${Zo(e[2])}`}a(lt,"rgb01ToHex");function $t(e){let t=String(e||"").trim().match(/^#?([0-9a-fA-F]{6})$/);if(!t)return null;let r=t[1],n=parseInt(r.slice(0,2),16),i=parseInt(r.slice(2,4),16),c=parseInt(r.slice(4,6),16);return!Number.isFinite(n)||!Number.isFinite(i)||!Number.isFinite(c)?null:[n/255,i/255,c/255]}a($t,"hexToRgb01");var qo=Object.freeze([.2126,.7152,.0722]),li=.5,xt=Object.freeze({scheme:"light",text:"#111111",mutedText:"#6b7280",frame:"#e5e7eb",surface:"#ffffff",surfaceInk:"#111111",halo:"#ffffff"}),fi=Object.freeze({scheme:"dark",text:"#f3f4f6",mutedText:"#9ca3af",frame:"#374151",surface:"#111827",surfaceInk:"#f3f4f6",halo:"#111827"});function fc({background:e,backgroundColor:o}){if(e==="transparent")return xt;let t=$t(o);if(t===null)throw new TypeError("Figure ink requires an exact #RRGGBB background colour.");return t[0]*qo[0]+t[1]*qo[1]+t[2]*qo[2]>=li?xt:fi}a(fc,"resolveFigureInk");function wn(e,o){let t=[[e,o]];for(;t.length>0;){let[r,n]=t.pop();if(r===n)continue;if(r===null||n===null||typeof r!="object"||typeof n!="object")return!1;let i=r instanceof Uint8Array;if(i!==n instanceof Uint8Array)return!1;if(i){if(r.length!==n.length)return!1;for(let h=0;h<r.length;h++)if(r[h]!==n[h])return!1;continue}let c=Array.isArray(r);if(c!==Array.isArray(n))return!1;if(c){if(r.length!==n.length)return!1;for(let h=0;h<r.length;h++)t.push([r[h],n[h]]);continue}let s=Object.keys(r),l=Object.keys(n);if(s.length!==l.length)return!1;for(let h of s){if(!Object.prototype.hasOwnProperty.call(n,h))return!1;t.push([r[h],n[h]])}}return!0}a(wn,"areLegendModelsSemanticallyEqual");var bo=" (hidden)",vn=4;function En(e,o,t){let r=[],n="";for(let i of e.split(" ")){let c=n===""?i:`${n} ${i}`;n!==""&&t(c)>o?(r.push(n),n=i):n=c}return n!==""&&r.push(n),r}a(En,"noteLines");var _n=1.25;function An(e){let o=Array.isArray(e)?e:[],t=Math.max(1,o.length-1);return o.map((r,n)=>{let i=String(r??"").trim(),c=/^(.*\S)\s+(-?\d+(?:\.\d+)?)%$/.exec(i),s=c===null?n/t:Number(c[2])/100;return{color:c===null?i:c[1],offset:Math.min(1,Math.max(0,s))}}).filter(r=>r.color!=="")}a(An,"colorBarStops");function Jo(e,o){return String(e??"").length*o*.62}a(Jo,"estimateTextWidthPxApprox");function ui(e,o,t){let r=String(e??"");if(o<=0)return"";if(Jo(r,t)<=o)return r;let n="…",i=Math.max(1e-4,t*.62),c=Math.max(0,Math.floor(o/i)-1);return c<=0?n:r.slice(0,c)+n}a(ui,"truncateTextApprox");function di(e,o,t){let r=String(o??"");if(t<=0)return"";if(e.measureText(r).width<=t)return r;let n="…";if(e.measureText(n).width>t)return"";let i=0,c=r.length;for(;i<c;){let s=Math.ceil((i+c)/2),l=r.slice(0,s)+n;e.measureText(l).width<=t?i=s:c=s-1}return r.slice(0,i)+n}a(di,"truncateCanvasTextToWidth");function xo(e,o){let t=e?.visible;if(t instanceof Uint8Array&&t[o]===0)return!0;let r=e?.counts?.available;return Array.isArray(r)&&r[o]===0}a(xo,"isCategoryHidden");function Mn({name:e,hidden:o,maxWidthPx:t,fit:r,measure:n}){let i=String(e??"");if(!o)return r(i,t);let c=t-n(bo);return`${r(i,c)}${bo}`}a(Mn,"composeCategoryLabel");function hi(e){return e?.logEnabled===!0||e?.scale==="log"||e?.colorbar?.scale==="log"}a(hi,"isLogColorScale");function Tn(e,o,t){let r=e?.geneSample??null,n=e?.zeroGray?.drawn===!0,i=r!==null?`${Hr(r)}. ${Xr(n)}`:n?"Gray: 0":null,c=[pi(e,o,t),i].filter(s=>s!==null);return c.length===0?null:c.join(" · ")}a(Tn,"buildColorScaleNote");function pi(e,o,t){if(!hi(e))return e?.colorbar?.centered===!0?"Color scale centred at 0":null;let r=Number(o),n=Number(t);return Number.isFinite(r)&&Number.isFinite(n)&&r>0&&n>0?`Log10 color scale (midpoint ${pt(Math.sqrt(r*n))})`:"Log10 color scale"}a(pi,"scaleNote");function vc(e){let o=null,t=null;for(let r of e){let n=r.scientificState.fieldKey,i=r.scientificState.legendModel;if(n===null||i===null)return null;if(o===null){o=n,t=i;continue}if(o!==n||!wn(t,i))return null}return o===null||t===null?null:{fieldKey:o,model:t}}a(vc,"resolveSharedGridLegend");function Ec({legendRect:e,fieldKey:o,model:t,fontFamily:r="Arial, Helvetica, sans-serif",fontSize:n=12,idPrefix:i="legend",backgroundFill:c="#ffffff",ink:s=xt}){let l=s.mutedText,h=s.text,d=s.mutedText;if(!e||!t)return{svg:"",defs:""};let u=e.x,m=e.y,A=e.width,y=e.height,b=8,T=Math.max(14,Math.round(n*1.2)),_=[],g=[];_.push(`<g font-family="${be(r)}" font-size="${n}" fill="${s.text}">`);let w=c==="transparent"?"none":c;_.push(`<rect x="${u}" y="${m}" width="${A}" height="${y}" fill="${be(w)}" stroke="${s.frame}" stroke-width="1"/>`);let C=o?String(o):t.kind==="continuous"?"Color scale":"Legend";_.push(`<text x="${u+b}" y="${m+b+n}" font-weight="600">${be(C)}</text>`);let E=m+b+n+8;if(t.kind==="category"){let L=t.categories||[],z=t.colors,P=10,F=E,R=m+y-b,$=Math.max(1,R-F),D=Math.max(1,Math.floor($/T)),B=Math.max(1,Math.ceil(L.length/D)),I=Math.max(1,(A-b*2)/B);for(let k=0;k<L.length;k++){let U=Math.floor(k/D),V=k%D,H=u+b+U*I,ce=F+V*T,re=H+P+6,xe=u+b+(U+1)*I,Ce=Math.max(0,xe-re-2),ze=xo(t,k),Ne=Mn({name:L[k],hidden:ze,maxWidthPx:Ce,fit:a(($e,He)=>ui($e,He,n),"fit"),measure:a($e=>Jo($e,n),"measure")});ze?_.push(`<rect x="${H}" y="${ce}" width="${P}" height="${P}" fill="none" stroke="${l}" stroke-width="1"/>`):_.push(`<rect x="${H}" y="${ce}" width="${P}" height="${P}" fill="${Lo(z,k)}" stroke="${h}" stroke-width="0.25"/>`),_.push(`<text x="${re}" y="${ce+P}" fill="${ze?l:h}" dominant-baseline="ideographic">${be(Ne)}</text>`)}}else if(t.kind==="continuous"){let L=`${i}_grad`,z=An(t.colorStops);g.push(`<linearGradient id="${L}" x1="0" x2="1" y1="0" y2="0">`);for(let k of z)g.push(`<stop offset="${+(k.offset*100).toFixed(3)}%" stop-color="${k.color}"/>`);g.push("</linearGradient>");let P=12,F=Math.max(40,A-b*2);_.push(`<rect x="${u+b}" y="${E}" width="${F}" height="${P}" fill="url(#${L})" stroke="${s.text}" stroke-width="0.5"/>`),E+=P+6;let R=t.colorbar?.min??t.stats?.min,$=t.colorbar?.max??t.stats?.max,D=pt(Number(R)),B=pt(Number($));_.push(`<text x="${u+b}" y="${E+n}" fill="${d}">${D}</text>`),_.push(`<text x="${u+b+F}" y="${E+n}" text-anchor="end" fill="${d}">${B}</text>`);let I=Tn(t,R,$);if(I!==null){let k=E+n*2+vn;En(I,F,U=>Jo(U,n)).forEach((U,V)=>{_.push(`<text x="${u+b}" y="${k+V*n*_n}" fill="${d}">${be(U)}</text>`)})}}return _.push("</g>"),{svg:_.join(""),defs:g.length?`<defs>${g.join("")}</defs>`:""}}a(Ec,"renderSvgLegend");function _c({ctx:e,legendRect:o,fieldKey:t,model:r,fontFamily:n="Arial, Helvetica, sans-serif",fontSize:i=12,backgroundFill:c="#ffffff",ink:s=xt}){let l=s.mutedText,h=s.text,d=s.mutedText;if(!e||!o||!r)return;let u=o.x,m=o.y,A=o.width,y=o.height,b=8,T=Math.max(14,Math.round(i*1.2));e.save(),c!=="transparent"&&(e.fillStyle=c,e.fillRect(u,m,A,y)),e.strokeStyle=s.frame,e.lineWidth=1,e.strokeRect(u,m,A,y),e.fillStyle=s.text,e.font=`600 ${i}px ${n}`,e.textAlign="left",e.textBaseline="alphabetic";let _=t?String(t):r.kind==="continuous"?"Color scale":"Legend";e.fillText(_,u+b,m+b+i);let g=m+b+i+8;if(e.font=`${i}px ${n}`,r.kind==="category"){let w=r.categories||[],C=r.colors,E=10,L=g,z=m+y-b,P=Math.max(1,z-L),F=Math.max(1,Math.floor(P/T)),R=Math.max(1,Math.ceil(w.length/F)),$=Math.max(1,(A-b*2)/R);e.save(),e.beginPath(),e.rect(u,m,A,y),e.clip();for(let D=0;D<w.length;D++){let B=Math.floor(D/F),I=D%F,k=u+b+B*$,U=L+I*T,V=k+E+6,H=u+b+(B+1)*$,ce=Math.max(0,H-V-2),re=xo(r,D);re?(e.strokeStyle=l,e.lineWidth=1,e.strokeRect(k,U,E,E)):(e.fillStyle=Lo(C,D),e.fillRect(k,U,E,E),e.strokeStyle=h,e.lineWidth=.5,e.strokeRect(k,U,E,E)),e.fillStyle=re?l:h;let xe=Mn({name:w[D],hidden:re,maxWidthPx:ce,fit:a((Ce,ze)=>di(e,Ce,ze),"fit"),measure:a(Ce=>e.measureText(Ce).width,"measure")});e.fillText(xe,V,U+E)}e.restore()}else if(r.kind==="continuous"){let C=Math.max(40,A-b*2),E=e.createLinearGradient(u+b,0,u+b+C,0);for(let F of An(r.colorStops))E.addColorStop(F.offset,F.color);e.fillStyle=E,e.fillRect(u+b,g,C,12),e.strokeStyle=s.text,e.lineWidth=.5,e.strokeRect(u+b,g,C,12),g+=18;let L=r.colorbar?.min??r.stats?.min,z=r.colorbar?.max??r.stats?.max;e.fillStyle=d,e.textAlign="left",e.fillText(pt(Number(L)),u+b,g+i),e.textAlign="right",e.fillText(pt(Number(z)),u+b+C,g+i);let P=Tn(r,L,z);P!==null&&(e.textAlign="left",En(P,C,F=>e.measureText(F).width).forEach((F,R)=>{e.fillText(F,u+b,g+i*2+vn+R*i*_n)}))}e.restore()}a(_c,"drawCanvasLegend");var mi=new Set([1,2,3]),bi=new Set(["points","smoke"]);function Sn(e){if(!mi.has(e))throw new RangeError(`Camera dimension must be exactly 1, 2, or 3; received ${String(e)}.`);return e===3?"orbit":"planar"}a(Sn,"getDefaultNavigationMode");function yo(e){if(typeof e!="string"||e.length===0)throw new TypeError("Renderer view id must be a non-empty string.");return e}a(yo,"assertViewId");function Qo(e,o){if(typeof e!="boolean")throw new TypeError(`${o} state must be an exact boolean.`);return e}a(Qo,"assertExactBoolean");function Fc(e,o,t,r){if(typeof e!="number"||!Number.isFinite(e))throw new TypeError(`${r} must be one finite number.`);if(e<o||e>t)throw new RangeError(`${r} must be between ${o} and ${t}.`);return e}a(Fc,"assertFiniteNumberInRange");function Lc(e,o,t,r){if(!Number.isSafeInteger(e))throw new TypeError(`${r} must be one safe integer.`);if(e<o||e>t)throw new RangeError(`${r} must be between ${o} and ${t}.`);return e}a(Lc,"assertIntegerInRange");function er(e,o){if(typeof e!="function")throw new TypeError(`${o} must be one function.`);return e}a(er,"assertExactFunction");function kn(e,o){if(typeof e!="string"||e.length===0||e!==e.trim())throw new TypeError(`${o} must be one non-empty string without leading or trailing whitespace.`);return e}a(kn,"assertNonEmptyTrimmedString");function Rn(e,o,t){if(!(e instanceof Float32Array))throw new TypeError(`${t} must be a Float32Array.`);if(e.length!==o)throw new RangeError(`${t} must contain exactly ${$o(o,"value")}; received ${e.length}.`);return e}a(Rn,"assertExactFloat32Array");function Cn(e,o,t){let r=Rn(e,o,t);if(jr(r))return r;for(let n=0;n<r.length;n+=1)if(!Number.isFinite(r[n]))throw new RangeError(`${t} value ${n} must be finite.`);return Gr(r),r}a(Cn,"assertFiniteFloat32Array");function xi(e,o,t,r){let n=Rn(e,o,r);return Lr(n)?n:Pr(n,t,r)}a(xi,"assertCellPositions");function Xt(e,o,t){if(!(e instanceof Uint8Array))throw new TypeError(`${t} must be a Uint8Array.`);if(e.length!==o)throw new RangeError(`${t} must contain exactly ${$o(o,"byte")}; received ${e.length}.`);return e}a(Xt,"assertExactUint8Array");function $n(e,o,t){let r=Xt(e,o,t),n=Ir(r);if(n>=0)throw new RangeError(`${t} value ${n} must be exactly 0 or 1.`);return r}a($n,"assertTransparencyArray");function yi(e,o){if(e!==null&&(typeof e!="string"||e.length===0))throw new TypeError(`${o} layoutKey must be a non-empty string or exact null.`);return e}a(yi,"assertViewLayoutKey");function Pc(e){let o=ve(e,["positions","colors","transparency","dimensionLevel","layoutKey"],"Viewer data"),t=o.dimensionLevel;Sn(t);let r=yi(o.layoutKey,"Viewer data");if(r===null&&o.positions?.length!==0)throw new TypeError("Viewer data with points must name the layout its positions belong to.");if(!(o.positions instanceof Float32Array)||o.positions.length%t!==0)throw new TypeError("Viewer positions must be a Float32Array with exactly dimensionLevel values per point.");let n=o.positions.length/t;return xi(o.positions,n*t,t,"Viewer positions"),Xt(o.colors,n*4,"Viewer colors"),$n(o.transparency,n,"Viewer transparency"),{positions:o.positions,colors:o.colors,transparency:o.transparency,dimensionLevel:t,layoutKey:r,pointCount:n}}a(Pc,"assertViewerDataPayload");function zc(e){let o=ve(e,["positions","colors"],"Centroid data");if(!(o.positions instanceof Float32Array)||o.positions.length%3!==0)throw new TypeError("Centroid positions must be a Float32Array with exactly three values per centroid.");let t=o.positions.length/3;return Cn(o.positions,t*3,"Centroid positions"),Xt(o.colors,t*4,"Centroid colors"),{positions:o.positions,colors:o.colors,count:t}}a(zc,"assertCentroidPayload");function gi(e,o="Snapshot metadata"){let t=ve(e,["filtersText"],o);if(!Array.isArray(t.filtersText)||t.filtersText.some(r=>typeof r!="string"||r.length===0||r.trim()!==r))throw new TypeError(`${o} filtersText must be an array of non-empty trimmed strings.`);return{filtersText:[...t.filtersText]}}a(gi,"cloneSnapshotMeta");function wi(e,o){if(e===null||o===null){if(e!==null||o!==null)throw new TypeError("Snapshot fieldKey and fieldKind must both be null or both be present.");return}if(kn(e,"Snapshot field key"),o!=="category"&&o!=="continuous")throw new RangeError('Snapshot field kind must be exactly "category", "continuous", or null.')}a(wi,"assertSnapshotFieldDescriptor");function Nc(e,o){let t=ve(e,["cameraState","centroidColors","centroidPositions","colors","dimensionLevel","fieldKey","fieldKind","label","meta","sourceViewId","transparency"],"Snapshot configuration");kn(t.label,"Snapshot label"),wi(t.fieldKey,t.fieldKind),Xt(t.colors,o*4,"Snapshot colors"),$n(t.transparency,o,"Snapshot transparency");let r=[t.centroidPositions,t.centroidColors],n=r.every(l=>l===null);if(!n&&r.some(l=>l===null))throw new TypeError("Snapshot centroid positions and colors must be published together.");let i=0;if(!n){if(!(t.centroidPositions instanceof Float32Array)||t.centroidPositions.length%3!==0)throw new TypeError("Snapshot centroid positions must contain complete Float32 XYZ triples.");i=t.centroidPositions.length/3,Cn(t.centroidPositions,i*3,"Snapshot centroid positions"),Xt(t.centroidColors,i*4,"Snapshot centroid colors")}let c=t.dimensionLevel;Sn(c);let s=co(t.cameraState,"Snapshot camera state");return{label:t.label,fieldKey:t.fieldKey,fieldKind:t.fieldKind,colors:t.colors,transparency:new Uint8Array(t.transparency),centroidPositions:n?null:new Float32Array(t.centroidPositions),centroidColors:n?null:new Uint8Array(t.centroidColors),centroidCount:i,meta:gi(t.meta),cameraState:s,dimensionLevel:c}}a(Nc,"assertSnapshotConfig");function Ic(e){if(!Array.isArray(e))throw new TypeError("Centroid labels must be an array.");for(let[o,t]of e.entries()){let r=t!==null&&typeof t=="object"&&!Array.isArray(t)?Object.keys(t).sort().join(","):"",n=r==="alpha,el,position";if(t===null||typeof t!="object"||Array.isArray(t)||Object.getPrototypeOf(t)!==Object.prototype||r!=="el,position"&&!n||!(t.el instanceof HTMLElement)||!Array.isArray(t.position)||t.position.length!==3||!t.position.every(i=>typeof i=="number"&&Number.isFinite(i))||n&&(typeof t.alpha!="number"||!Number.isFinite(t.alpha)||t.alpha<0||t.alpha>1))throw new TypeError(`Centroid label ${o} must be an exact element/finite-3D-position record with optional finite alpha from 0 through 1.`)}return e}a(Ic,"assertCentroidLabelEntries");function Dc(e){if(!ho(e))throw new TypeError(sn);return e}a(Dc,"assertViewerBackground");function Bc(e){if(!bi.has(e))throw new TypeError('Render mode must be exactly "points" or "smoke".');return e}a(Bc,"assertRenderMode");function Hc(e,o,t){let r=er(e,"Borrowed-view-data callback"),n=er(t,"Borrowed-view-data validator"),i,c=!1,s;try{i=r(o)}catch(d){c=!0,s=d}if(c){try{n()}catch(d){throw new AggregateError([s,d],"Borrowed-view-data callback failed while its ownership also changed.")}throw s}let l=null;try{i!==null&&(typeof i=="object"||typeof i=="function")&&typeof i.then=="function"&&(l=new TypeError("Borrowed-view-data callback must complete synchronously and must not return a Promise or thenable."))}catch(d){l=d}let h=null;try{n()}catch(d){h=d}if(l!==null&&h!==null)throw new AggregateError([l,h],"Borrowed-view-data result failed while its ownership also changed.");if(h!==null)throw h;if(l!==null)throw l;return i}a(Hc,"runSynchronousBorrowedViewDataCallback");function On(e,o){if(typeof e!="number"||!Number.isFinite(e)||e<=0)throw new TypeError(`${o} must be one positive finite number.`);return e}a(On,"assertPositiveFinite");function tr(e){if(!Number.isSafeInteger(e)||e<=0)throw new RangeError("Presented grid view count must be a positive safe integer.");return e<=3?e:Math.ceil(Math.sqrt(e))}a(tr,"getPresentedGridColumns");function Wc(e){if(e===null||typeof e!="object"||Array.isArray(e))throw new TypeError("Presented layout requires one exact options object.");let{canvasHeight:o,canvasWidth:t,focusedViewId:r,mode:n,viewIds:i}=e;if(!Number.isSafeInteger(t)||t<=0||!Number.isSafeInteger(o)||o<=0)throw new TypeError("Presented-view canvas dimensions must be positive safe integers.");let c=On(e.cssWidth,"Presented CSS width"),s=On(e.cssHeight,"Presented CSS height"),l=e.leftOcclusionRatio;if(typeof l!="number"||!(l>=0&&l<=1))throw new RangeError("Presented left occlusion ratio must be a number between 0 and 1.");if(n!=="single"&&n!=="grid")throw new TypeError('Presented-view layout mode must be exactly "single" or "grid".');let h=yo(r);if(!Array.isArray(i)||i.length===0||i.some(w=>typeof w!="string"||w.length===0)||new Set(i).size!==i.length)throw new TypeError("Presented-view inventory must contain unique non-empty view IDs.");let d=c/t,u=s/o,m=i.length,A=n==="grid"&&m>1,y=A?tr(m):1,b=A?Math.ceil(m/y):1,T=t-y;if(T<0||o<b)throw new RangeError("Presented-view grid panes must have positive framebuffer dimensions.");let _=[],g;if(A){let w=Math.min(T,Math.max(0,Math.ceil(l*t-1e-6)));g=w*d;let C=Math.floor((t-w)/y),E=Math.floor(o/b);for(let L=0;L<m;L+=1){let z=L%y,P=Math.floor(L/y),F=w+z*C,R=P*E,$=F*d,D=R*u,B=C*d,I=E*u;_.push(Object.freeze({col:z,cssHeight:I,cssLeft:$,cssTop:D,cssWidth:B,projectionCenterNdcX:0,row:P,scissorEnabled:!0,viewId:i[L],viewIndex:L,viewportHeight:E,viewportWidth:C,viewportX:F,viewportY:o-R-E,visibleCssHeight:I,visibleCssLeft:$,visibleCssTop:D,visibleCssWidth:B}))}}else{let w=i.indexOf(h);if(w<0)throw new RangeError(`Focused view "${h}" is absent from the presented render inventory.`);let C=Math.min(l,T/t);g=C*c,_.push(Object.freeze({col:0,cssHeight:s,cssLeft:0,cssTop:0,cssWidth:c,projectionCenterNdcX:C,row:0,scissorEnabled:!1,viewId:h,viewIndex:w,viewportHeight:o,viewportWidth:t,viewportX:0,viewportY:0,visibleCssHeight:s,visibleCssLeft:g,visibleCssTop:0,visibleCssWidth:c-g}))}return Object.freeze({canvasHeight:o,canvasWidth:t,cols:y,cssHeight:s,cssWidth:c,gridMultiview:A,layoutMode:n,leftOcclusionRatio:l,panes:Object.freeze(_),presentedArea:Object.freeze({cssHeight:s,cssLeft:g,cssTop:0,cssWidth:c-g}),rows:b,viewCount:m})}a(Wc,"resolvePresentedLayout");function Yc(e,o){let t=yo(o);if(e===null||typeof e!="object"||!Array.isArray(e.panes))throw new TypeError("Presented pane lookup requires one resolved layout.");for(let r of e.panes)if(r.viewId===t)return r;throw new RangeError(`View "${t}" is not presented in the current ${e.layoutMode} layout.`)}a(Yc,"getPresentedPane");function Kc(e,o,t){if(!Number.isFinite(o)||!Number.isFinite(t))throw new TypeError("Presented pane hit testing requires a finite point.");if(!e.gridMultiview)return e.panes[0];let r=e.panes[0],n=Math.max(0,Math.min(e.cols-1,Math.floor((o-r.cssLeft)/r.cssWidth))),i=Math.max(0,Math.min(e.rows-1,Math.floor(t/r.cssHeight)));return e.panes[i*e.cols+n]??null}a(Kc,"getPresentedPaneAtCssPoint");function Vc(e){if(e===null||typeof e!="object"||Array.isArray(e))throw new TypeError("Presented-view camera selection requires one exact options object.");let o=yo(e.viewId),t=Qo(e.followsFocusedCamera,"Presented-view camera following"),i=Qo(e.gridMultiview,"Presented-view grid ownership")&&!t?e.storedCameraState:e.globalCameraState;return co(i,`Presented camera state for view "${o}"`)}a(Vc,"selectPresentedCameraState");var tt=20,go=34,Wt=16,ar=240,ir=140,Ot=8,Fn=10,Ln=6,Pn=2,zn=.62,wo=62,sr=62,cr=10,lr=10,_t=10,Ht=8,or=96,rr=44,nr=.5;function Nn(e){let o=e.categories||[],t=0;for(let r=0;r<o.length;r++){let n=String(o[r]??"").length+(xo(e,r)?bo.length:0);n>t&&(t=n)}return t}a(Nn,"longestCategoryEntryLength");function In({model:e,fontSizePx:o,plotHeight:t,minimumWidth:r=ar}){if(!e||e.kind!=="category")return r;let n=e.categories||[];if(!n.length)return r;let i=Math.max(14,Math.round(o*1.2)),c=Ot+o+8,s=Math.max(1,t-c-Ot),l=Math.max(1,Math.floor(s/i)),h=Math.max(1,Math.ceil(n.length/l)),d=Nn(e)*o*zn,u=Fn+Ln+d+Pn,m=Math.ceil(Ot*2+h*u);return Math.max(r,m)}a(In,"estimateLegendWidthRight");function Dn({model:e,fontSizePx:o,plotWidth:t,minimumHeight:r=ir}){if(!e||e.kind!=="category")return r;let n=e.categories||[];if(!n.length)return r;let i=Nn(e)*o*zn,c=Fn+Ln+i+Pn,s=Math.max(14,Math.round(o*1.2)),l=Ot+o+8,h=Math.max(1,t-Ot*2),d=Math.max(1,Math.floor(h/Math.max(1,c))),u=Math.max(1,Math.ceil(n.length/d)),m=Math.ceil(l+u*s+Ot);return Math.max(r,m)}a(Dn,"estimateLegendHeightBottom");function vi({desiredPlotWidth:e,desiredPlotHeight:o,hasTitle:t=!1,includeAxes:r=!0,includeLegend:n=!0,legendPosition:i="right",legendModel:c=null,legendFontSizePx:s=12}){let l=Math.max(1,Math.round(e)),h=Math.max(1,Math.round(o)),d=Math.max(6,Math.round(Number(s)||12)),u=r?wo:_t,m=r?lr:_t,A=r?cr:_t,y=r?sr:_t,b=n&&i==="right"?Math.min(l,In({model:c,fontSizePx:d,plotHeight:h})):0,T=n&&i==="bottom"?Math.min(h,Dn({model:c,fontSizePx:d,plotWidth:l})):0,_=b>0?Wt:0,g=T>0?Wt:0,w=t?go:0,C=tt+u+l+m+_+b+tt,E=tt+w+A+h+y+g+T+tt;return{totalWidth:C,totalHeight:E,plotWidth:l,plotHeight:h,legendWidth:b,legendHeight:T}}a(vi,"computeExpandedDimensions");function tl({width:e,height:o,title:t="",includeAxes:r=!0,includeLegend:n=!0,legendPosition:i="right",legendModel:c=null,legendFontSizePx:s=12}){let l=!!String(t||"").trim(),h=Math.max(1,Math.round(e)),d=Math.max(1,Math.round(o)),u=vi({desiredPlotWidth:h,desiredPlotHeight:d,hasTitle:l,includeAxes:r,includeLegend:n,legendPosition:i,legendModel:c,legendFontSizePx:s}),m=r?wo:_t,A=r?cr:_t,y=l?go:0,b={x:tt+m,y:tt+y+A,width:h,height:d},T=n?i==="right"?{x:b.x+b.width+Wt,y:b.y,width:u.legendWidth,height:b.height}:{x:b.x,y:b.y+b.height+Wt,width:b.width,height:u.legendHeight}:null,_=u.totalWidth-tt*2,g=l?{x:tt,y:tt,width:_,height:go}:null;return{outerPadding:tt,totalWidth:u.totalWidth,totalHeight:u.totalHeight,titleRect:g,plotRect:b,legendRect:T}}a(tl,"computeSingleViewLayout");function ol({cellX:e,cellY:o,cellWidth:t,cellHeight:r,includeAxes:n,fontSize:i,legendModel:c=null,legendPosition:s="right",legendFontSizePx:l=12}){let h=Te(Math.round(i*.65),6,12),d=Math.max(1,t-h*2),u=Math.max(1,r-h*2),m=Math.min(Math.max(18,Math.round(i*1.5)),Math.max(0,u-1)),A=Math.max(1,u-m),y=Math.max(6,Math.round(Number(l)||12)),b=null,T=0,_=0;if(c!==null)if(s==="right"){let R=Math.floor(d*nr)-Ht;if(R>=or){let $=Math.min(R,Math.min(ar,In({model:c,fontSizePx:y,plotHeight:A,minimumWidth:or})));T=$+Ht,b={x:e+h+d-$,y:o+h+m,width:$,height:A}}}else{let R=Math.floor(A*nr)-Ht;if(R>=rr){let $=Math.min(R,Math.min(ir,Dn({model:c,fontSizePx:y,plotWidth:d,minimumHeight:rr})));_=$+Ht,b={x:e+h,y:o+h+u-$,width:d,height:$}}}let g=Math.max(1,d-T),w=Math.max(1,A-_),C=Math.min(80,Math.max(1,g*.45)),E=Math.min(64,Math.max(1,w*.45)),L=n?Math.min(lr,Math.max(0,g-C)):0,z=n?Math.min(wo,Math.max(0,g-L-C)):0,P=n?Math.min(sr,Math.max(0,w-E)):0,F={x:e+h+z,y:o+h+m,width:Math.max(1,g-z-L),height:Math.max(1,w-P)};return{labelX:F.x,labelY:o+h+Math.min(i,Math.max(1,m)),panelRect:{x:e+1,y:o+1,width:Math.max(1,t-2),height:Math.max(1,r-2)},plotRect:F,legendRect:b}}a(ol,"computeGridPaneLayout");function rl(e){let o=Math.max(1,e),t=tr(o);return{cols:t,rows:Math.ceil(o/t)}}a(rl,"computeGridDims");var nl={OUTER_PADDING:tt,TITLE_HEIGHT:go,LEGEND_GAP:Wt,LEGEND_WIDTH_RIGHT:ar,LEGEND_HEIGHT_BOTTOM:ir,AXIS_LEFT_SPACE:wo,AXIS_BOTTOM_SPACE:sr,AXIS_TOP_SPACE:cr,AXIS_RIGHT_SPACE:lr,NO_AXIS_PADDING:_t,PANEL_LEGEND_GAP:Ht,PANEL_LEGEND_MIN_WIDTH:or,PANEL_LEGEND_MIN_HEIGHT:rr,PANEL_LEGEND_MAX_SHARE:nr};function Bn(e){return+`1e${e}`}a(Bn,"powerOfTen");function fr(e,o,t=5){let r=Number(e),n=Number(o);if(!Number.isFinite(r)||!Number.isFinite(n))return{ticks:[0],niceMin:0,niceMax:0,step:1};if(r===n){let _=r===0?1:Bn(Math.floor(Math.log10(Math.abs(r))));return{ticks:[r],niceMin:r,niceMax:r,step:_}}let i=Math.min(r,n),c=Math.max(r,n),l=(c-i)/Math.max(1,t),h=Bn(Math.floor(Math.log10(Math.abs(l)))),d=l/h,u;d<=1?u=1*h:d<=2?u=2*h:d<=5?u=5*h:u=10*h;let m=Math.floor(i/u)*u,A=Math.ceil(c/u)*u,y=[],b=2048,T=m;for(let _=0;_<b&&T<=A+u*.5;_++)y.push(+T.toFixed(12)),T+=u;return{ticks:y,niceMin:m,niceMax:A,step:u}}a(fr,"niceNumbers");function Un({ticks:e,step:o}){let t=0;for(let n of e)t=Math.max(t,Math.abs(n));let r=Fr(t,o);return e.map(n=>pt(n,r))}a(Un,"tickLabels");function jn(e,o=5){let t=fr(e.minX,e.maxX,o),r=fr(e.minY,e.maxY,o);return{xTicks:t.ticks,yTicks:r.ticks,xLabels:Un(t),yLabels:Un(r),xNice:{min:t.niceMin,max:t.niceMax},yNice:{min:r.niceMin,max:r.niceMax}}}a(jn,"buildAxesModel");function dl({plotRect:e,bounds:o,xLabel:t="X",yLabel:r="Y",fontFamily:n="Arial, Helvetica, sans-serif",tickFontSize:i=null,labelFontSize:c=null,axisGapPx:s=6,color:l="#111"}){let h=Math.max(6,Math.round(Number(i)||12)),d=Number.isFinite(c)?Math.max(6,Math.round(c)):h,u=jn(o,5),m=l,A=Math.max(0,Math.round(Number(s)||0)),y=5,b=Math.max(12,Math.round(d*1.15)),T=8,_=String(t??"").trim(),g=String(r??"").trim(),w=e.x,C=e.x+e.width,E=e.y,L=e.y+e.height,z=w-A,P=L+A,F=[];F.push(`<g font-family="${be(n)}" font-size="${h}" fill="${be(m)}" stroke="${be(m)}" stroke-width="1">`),F.push(`<line x1="${w}" y1="${P}" x2="${C}" y2="${P}"/>`),F.push(`<line x1="${z}" y1="${E}" x2="${z}" y2="${L}"/>`);let R=u.xNice.max-u.xNice.min||1;u.xTicks.forEach((D,B)=>{let I=(D-u.xNice.min)/R,k=w+I*e.width;F.push(`<line x1="${k}" y1="${P}" x2="${k}" y2="${P+y}"/>`),F.push(`<text x="${k}" y="${P+y+T}" text-anchor="middle" stroke="none">${u.xLabels[B]}</text>`)});let $=u.yNice.max-u.yNice.min||1;if(u.yTicks.forEach((D,B)=>{let I=(D-u.yNice.min)/$,k=L-I*e.height;F.push(`<line x1="${z}" y1="${k}" x2="${z-y}" y2="${k}"/>`),F.push(`<text x="${z-y-T}" y="${k+4}" text-anchor="end" stroke="none">${u.yLabels[B]}</text>`)}),_&&F.push(`<text x="${(w+C)/2}" y="${P+y+T+b}" text-anchor="middle" stroke="none" font-size="${d}">${be(_)}</text>`),g){let D=z-y-T-b,B=(E+L)/2;F.push(`<text x="${D}" y="${B}" text-anchor="middle" stroke="none" font-size="${d}" transform="rotate(-90 ${D} ${B})">${be(g)}</text>`)}return F.push("</g>"),F.join("")}a(dl,"renderSvgAxes");function hl({ctx:e,plotRect:o,bounds:t,xLabel:r="X",yLabel:n="Y",fontFamily:i="Arial, Helvetica, sans-serif",tickFontSize:c=null,labelFontSize:s=null,axisGapPx:l=6,color:h="#111"}){let d=Math.max(6,Math.round(Number(c)||12)),u=Number.isFinite(s)?Math.max(6,Math.round(s)):d,m=jn(t,5),A=Math.max(0,Math.round(Number(l)||0)),y=5,b=Math.max(12,Math.round(u*1.15)),T=8,_=String(r??"").trim(),g=String(n??"").trim(),w=o.x,C=o.x+o.width,E=o.y,L=o.y+o.height,z=w-A,P=L+A;e.save(),e.strokeStyle=h,e.fillStyle=h,e.lineWidth=1,e.font=`${d}px ${i}`,e.textBaseline="alphabetic",e.beginPath(),e.moveTo(w,P),e.lineTo(C,P),e.moveTo(z,E),e.lineTo(z,L),e.stroke();let F=m.xNice.max-m.xNice.min||1;m.xTicks.forEach(($,D)=>{let B=($-m.xNice.min)/F,I=w+B*o.width;e.beginPath(),e.moveTo(I,P),e.lineTo(I,P+y),e.stroke(),e.textAlign="center",e.fillText(m.xLabels[D],I,P+y+T)});let R=m.yNice.max-m.yNice.min||1;m.yTicks.forEach(($,D)=>{let B=($-m.yNice.min)/R,I=L-B*o.height;e.beginPath(),e.moveTo(z,I),e.lineTo(z-y,I),e.stroke(),e.textAlign="right",e.fillText(m.yLabels[D],z-y-2,I+4)}),(_||g)&&(e.font=`${u}px ${i}`,e.textAlign="center"),_&&e.fillText(_,(w+C)/2,P+y+T+b),g&&(e.save(),e.translate(z-y-T-b,(E+L)/2),e.rotate(-Math.PI/2),e.textAlign="center",e.fillText(g,0,0),e.restore()),e.restore()}a(hl,"drawCanvasAxes");function vo(e){return Number(e)*180/Math.PI}a(vo,"toDegrees");function Eo(e){let o=Number(e);if(!Number.isFinite(o))return 0;for(;o<=-180;)o+=360;for(;o>180;)o-=360;return o}a(Eo,"normalizeDegrees");function Ft(e,o){let t=e,r=o[0],n=o[1],i=o[2];return[t[0]*r+t[4]*n+t[8]*i,t[1]*r+t[5]*n+t[9]*i,t[2]*r+t[6]*n+t[10]*i]}a(Ft,"transformDirection");function Gn(e,o){return Math.sqrt(e*e+o*o)||1}a(Gn,"length2");function Ei(e,o,t,r,n,i){let c=Te(i,0,Math.min(r,n)/2);if(typeof e.roundRect=="function"){e.beginPath(),e.roundRect(o,t,r,n,c);return}e.beginPath(),e.moveTo(o+c,t),e.arcTo(o+r,t,o+r,t+n,c),e.arcTo(o+r,t+n,o,t+n,c),e.arcTo(o,t+n,o,t,c),e.arcTo(o,t,o+r,t,c),e.closePath()}a(Ei,"beginRoundRectPath");function Xn(e){let o=wt(e,"Orientation-indicator camera state"),t=o.navigationMode;if(t==="orbit"){let r=o.orbit.theta,n=o.orbit.phi,i=Eo(vo(r)),c=Te(Eo(90-vo(n)),-90,90);return[`az ${i.toFixed(0)}°`,`el ${c.toFixed(0)}°`]}if(t==="free"){let r=o.freefly.yaw,n=o.freefly.pitch,i=Eo(vo(r)),c=Te(Eo(vo(n)),-90,90);return[`yaw ${i.toFixed(0)}°`,`pit ${c.toFixed(0)}°`]}return[]}a(Xn,"getAngleLines");function wl({plotRect:e,viewMatrix:o,cameraState:t,fontFamily:r="Arial, Helvetica, sans-serif",fontSize:n=11,sizePx:i=null,marginPx:c=null,padPx:s=null,ink:l=xt}){let h=l.surfaceInk;if(!e||!o)return"";let d=Te(Math.round(Number(n)||11),6,48),u=Te(Math.round(Number.isFinite(c)?c:d*.9),8,18),m=Math.floor(Math.min(e.width,e.height)-u*2);if(!Number.isFinite(m)||m<50)return"";let A=Number.isFinite(i)?i:d*6.5,y=Te(Math.round(A),76,Math.min(160,m)),b=Te(Math.round(Number.isFinite(s)?s:d*.7),6,Math.max(6,Math.round(y*.18))),T=Math.max(2,Math.round(d/5)),_=Te(Math.round(d*.55),6,10),g=e.x+e.width-y-u,w=e.y+u,C=g+y/2,E=Xn(t),L=Math.max(10,Math.round(d*1.15)),z=E.length?E.length*L+4:0,P=Math.max(1,y-b*2-z),F=w+b+P/2,R=Math.max(10,Math.min(y-b*2,P)*.38),$=Ft(o,[1,0,0]),D=Ft(o,[0,1,0]),B=Ft(o,[0,0,1]),I=[{name:"X",v:$,color:"#ef4444"},{name:"Y",v:D,color:"#22c55e"},{name:"Z",v:B,color:"#3b82f6"}];I.sort((U,V)=>(V.v[2]||0)-(U.v[2]||0));let k=[];k.push(`<g font-family="${be(r)}" font-size="${d}" fill="${be(h)}">`),k.push(`<rect x="${g}" y="${w}" width="${y}" height="${y}" rx="${_}" fill="${l.surface}" fill-opacity="0.85" stroke="${l.frame}" stroke-width="1"/>`);for(let U of I){let V=U.v[0],H=U.v[1],ce=U.v[2],re=Gn(V,H),xe=V/re*R,Ce=-H/re*R,ze=Te(.35+(1-(ce+1)/2)*.65,.35,1),Ne=C+xe,$e=F+Ce,He=xe/Math.max(1e-6,R),We=Ce/Math.max(1e-6,R),Ye=Te(Math.round(d*.55),5,10),Se=Ne+He*Ye,M=$e+We*Ye,j=He>.25?"start":He<-.25?"end":"middle";k.push(`<line x1="${C}" y1="${F}" x2="${Ne}" y2="${$e}" stroke="${U.color}" stroke-width="${T}" stroke-linecap="round" opacity="${ze.toFixed(3)}"/>`),k.push(`<text x="${Se}" y="${M}" text-anchor="${j}" dominant-baseline="middle" fill="${U.color}" font-weight="600" opacity="${ze.toFixed(3)}" stroke="none">${U.name}</text>`)}if(E.length){let U=w+y-b;for(let V=0;V<E.length;V++){let H=U-(E.length-1-V)*L;k.push(`<text x="${g+y/2}" y="${H}" text-anchor="middle" fill="${l.surfaceInk}" stroke="none">${be(E[V])}</text>`)}}return k.push("</g>"),k.join("")}a(wl,"renderSvgOrientationIndicator");function vl({ctx:e,plotRect:o,viewMatrix:t,cameraState:r,fontFamily:n="Arial, Helvetica, sans-serif",fontSize:i=11,sizePx:c=null,marginPx:s=null,padPx:l=null,ink:h=xt}){if(!e||!o||!t)return;let d=Te(Math.round(Number(i)||11),6,48),u=Te(Math.round(Number.isFinite(s)?s:d*.9),8,18),m=Math.floor(Math.min(o.width,o.height)-u*2);if(!Number.isFinite(m)||m<50)return;let A=Number.isFinite(c)?c:d*6.5,y=Te(Math.round(A),76,Math.min(160,m)),b=Te(Math.round(Number.isFinite(l)?l:d*.7),6,Math.max(6,Math.round(y*.18))),T=Math.max(2,Math.round(d/5)),_=Te(Math.round(d*.55),6,10),g=o.x+o.width-y-u,w=o.y+u,C=g+y/2,E=Xn(r),L=Math.max(10,Math.round(d*1.15)),z=E.length?E.length*L+4:0,P=Math.max(1,y-b*2-z),F=w+b+P/2,R=Math.max(10,Math.min(y-b*2,P)*.38),$=Ft(t,[1,0,0]),D=Ft(t,[0,1,0]),B=Ft(t,[0,0,1]),I=[{name:"X",v:$,color:"#ef4444"},{name:"Y",v:D,color:"#22c55e"},{name:"Z",v:B,color:"#3b82f6"}];I.sort((k,U)=>(U.v[2]||0)-(k.v[2]||0)),e.save(),e.globalAlpha=.85,e.fillStyle=h.surface,e.strokeStyle=h.frame,e.lineWidth=1,Ei(e,g,w,y,y,_),e.fill(),e.globalAlpha=1,e.stroke();for(let k of I){let U=k.v[0],V=k.v[1],H=k.v[2],ce=Gn(U,V),re=U/ce*R,xe=-V/ce*R,Ce=Te(.35+(1-(H+1)/2)*.65,.35,1),ze=C+re,Ne=F+xe;e.globalAlpha=Ce,e.strokeStyle=k.color,e.lineWidth=T,e.beginPath(),e.moveTo(C,F),e.lineTo(ze,Ne),e.stroke();let $e=re/Math.max(1e-6,R),He=xe/Math.max(1e-6,R),We=Te(Math.round(d*.55),5,10),Ye=ze+$e*We,Se=Ne+He*We;e.fillStyle=k.color,e.font=`600 ${d}px ${n}`,e.textAlign=$e>.25?"left":$e<-.25?"right":"center",e.textBaseline="middle",e.fillText(k.name,Ye,Se)}if(e.globalAlpha=1,E.length){e.fillStyle=h.surfaceInk,e.font=`${d}px ${n}`,e.textAlign="center",e.textBaseline="alphabetic";let k=w+y-b;for(let U=0;U<E.length;U++){let V=k-(E.length-1-U)*L;e.fillText(E[U],g+y/2,V)}}e.restore()}a(vl,"drawCanvasOrientationIndicator");function Hn(e){return{points:!!e?.points,labels:!!e?.labels}}a(Hn,"normalizeFlags");function Wn(e,o){if(!Array.isArray(e)||!Number.isFinite(o))return"";let t=e[o];return t==null?"":String(t)}a(Wn,"getLabelAtIndex");function kl({positions:e,colors:o,labelTexts:t=null,flags:r=null,renderState:n,plotRect:i,pointRadiusPx:c,crop:s=null,fontFamily:l="Arial, Helvetica, sans-serif",labelFontSizePx:h=12,labelColor:d="#111",haloColor:u="#ffffff"}){let m=Hn(r);if(!m.points&&!m.labels||!e||!o||!n?.mvpMatrix)return"";let A=Math.max(6,Math.round(Number(h)||12)),y=Math.max(1.5,Math.round(A*.28)),b=Math.max(.5,Math.min(2.5,Number(c||1)*.18)),T=be(d),_=[];return _.push(`<g font-family="${be(l)}" fill="${be(d)}">`),Po({positions:e,dimension:3,colors:o,colorAlpha:"opacity",transparency:null,renderState:n,plotRect:i,radiusPx:Math.max(.5,Number(c)||.5),lodMembership:null,crop:s,sortByDepth:!1,onPoint:a((g,w,C,E,L,z,P,F)=>{if(!(z<Oo)){if(m.points){let R=`rgb(${C},${E},${L})`;z>=.999?_.push(`<circle cx="${g.toFixed(2)}" cy="${w.toFixed(2)}" r="${P.toFixed(2)}" fill="${R}" stroke="${T}" stroke-width="${b.toFixed(2)}"/>`):_.push(`<circle cx="${g.toFixed(2)}" cy="${w.toFixed(2)}" r="${P.toFixed(2)}" fill="${R}" fill-opacity="${z.toFixed(3)}" stroke="${T}" stroke-width="${b.toFixed(2)}" stroke-opacity="${z.toFixed(3)}"/>`)}if(m.labels){let R=Wn(t,F);if(!R)return;let $=be(R),D=g.toFixed(2),B=w.toFixed(2);_.push(`<text x="${D}" y="${B}" font-size="${A}" text-anchor="middle" dy="0.35em" stroke="${be(u)}" stroke-width="${y}" stroke-linejoin="round" fill="none">${$}</text>`),_.push(`<text x="${D}" y="${B}" font-size="${A}" text-anchor="middle" dy="0.35em" fill="${be(d)}">${$}</text>`)}}},"onPoint")}),_.push("</g>"),_.join("")}a(kl,"renderSvgCentroidOverlay");function Rl({ctx:e,positions:o,colors:t,labelTexts:r=null,flags:n=null,renderState:i,plotRect:c,pointRadiusPx:s,crop:l=null,fontFamily:h="Arial, Helvetica, sans-serif",labelFontSizePx:d=12,labelColor:u="#111",haloColor:m="rgba(255,255,255,0.95)"}){let A=Hn(n);if(!A.points&&!A.labels||!e||!o||!t||!i?.mvpMatrix)return;let y=Math.max(6,Math.round(Number(d)||12)),b=Math.max(1,Math.round(y*.28)),T=$t(u),_=T===null?[17,17,17]:T.map(g=>Math.round(g*255));e.save(),e.font=`${y}px ${h}`,e.textAlign="center",e.textBaseline="alphabetic",Po({positions:o,dimension:3,colors:t,colorAlpha:"opacity",transparency:null,renderState:i,plotRect:c,radiusPx:Math.max(.5,Number(s)||.5),lodMembership:null,crop:l,sortByDepth:!1,onPoint:a((g,w,C,E,L,z,P,F)=>{if(!(z<Oo)&&(A.points&&(e.fillStyle=`rgba(${C},${E},${L},${z})`,e.beginPath(),e.arc(g,w,P,0,Math.PI*2),e.fill(),e.strokeStyle=`rgba(${_[0]},${_[1]},${_[2]},${z})`,e.lineWidth=Math.max(.5,Math.min(2.5,P*.18)),e.stroke()),A.labels)){let R=Wn(r,F);if(!R)return;e.lineWidth=b,e.strokeStyle=m,e.fillStyle=u,e.strokeText(R,g,w+y*.35),e.fillText(R,g,w+y*.35)}},"onPoint")}),e.restore()}a(Rl,"drawCanvasCentroidOverlay");function Qe(e,o){let[t,r,n]=o;return{x:e[0]*t+e[4]*r+e[8]*n+e[12],y:e[1]*t+e[5]*r+e[9]*n+e[13],z:e[2]*t+e[6]*r+e[10]*n+e[14],w:e[3]*t+e[7]*r+e[11]*n+e[15]}}a(Qe,"toClipSpace");function _o(e,o){let t=0,r=1,n=[[e.z+e.w,o.z+o.w],[e.w-e.z,o.w-o.z]];for(let[i,c]of n){if(i<0&&c<0)return null;if(i===c)continue;let s=i/(i-c);i<0?s>t&&(t=s):c<0&&s<r&&(r=s)}return r>t?[t,r]:null}a(_o,"clipSegmentDepthRange");function yt(e,o,t){return[e[0]+(o[0]-e[0])*t,e[1]+(o[1]-e[1])*t,e[2]+(o[2]-e[2])*t]}a(yt,"lerpPoint");function Lt({renderState:e,plotRect:o,crop:t=null}){let r=Math.max(1,e.viewportWidth||1),n=Math.max(1,e.viewportHeight||1),i=so(t),c=Wr(i,r,n),s=!!(c&&(c.width<r-.5||c.height<n-.5||c.x>.5||c.y>.5)),l=s&&c?c.x:0,h=s&&c?c.y:0,d=s&&c?c.width:r,u=s&&c?c.height:n,m=Math.min(o.width/d,o.height/u),A=o.x+(o.width-d*m)/2,y=o.y+(o.height-u*m)/2,b=a((g,w)=>({x:A+(g-l)*m,y:y+(w-h)*m}),"viewportToPlot"),T=a(g=>g.w>1e-9?{x:(g.x/g.w*.5+.5)*r,y:(-g.y/g.w*.5+.5)*n}:null,"clipToViewport");return{viewportW:r,viewportH:n,srcX0:l,srcY0:h,srcW:d,srcH:u,scale:m,viewportToPlot:b,clipToViewport:T,toPlot:a(g=>{let w=T(g);return w===null?null:b(w.x,w.y)},"toPlot")}}a(Lt,"createPlotProjection");var ur=64,dr=40,Yn=24,Kn=12,Vn=.5/255,Zn=Math.log(Ge.ratio);function Ao(e,o,t){return[e[0]+(o[0]-e[0])*t,e[1]+(o[1]-e[1])*t,e[2]+(o[2]-e[2])*t]}a(Ao,"mixRgb");function _i(e){let o=e[0],t=e[1],r=e[2],n=e[3],i=e[4],c=e[5],s=e[6],l=e[7],h=e[8],d=e[9],u=e[10],m=e[11],A=e[12],y=e[13],b=e[14],T=e[15],_=o*c-t*i,g=o*s-r*i,w=o*l-n*i,C=t*s-r*c,E=t*l-n*c,L=r*l-n*s,z=h*y-d*A,P=h*b-u*A,F=h*T-m*A,R=d*b-u*y,$=d*T-m*y,D=u*T-m*b,B=_*D-g*$+w*R+C*F-E*P+L*z;if(!Number.isFinite(B)||B===0)return null;let I=1/B;return[(c*D-s*$+l*R)*I,(r*$-t*D-n*R)*I,(y*L-b*E+T*C)*I,(u*E-d*L-m*C)*I,(s*F-i*D-l*P)*I,(o*D-r*F+n*P)*I,(b*w-A*L-T*g)*I,(h*L-u*w+m*g)*I,(i*$-c*F+l*z)*I,(t*F-o*$-n*z)*I,(A*E-y*w+T*_)*I,(d*w-h*E-m*_)*I,(c*P-i*R-s*z)*I,(o*R-t*P+r*z)*I,(y*g-A*C-b*_)*I,(h*C-d*g+u*_)*I]}a(_i,"invertMatrix4");function hr(e){if(e===0)return 1/0;let o=0,t=Math.abs(e);for(;t%Ge.ratio===0&&o<64;)t/=Ge.ratio,o+=1;return o}a(hr,"divisibilityDepth");function Jn({appearance:e,renderState:o,plotRect:t,crop:r=null,surface:n}){let i=o?.backdrop;if(!(o?.mvpMatrix instanceof Float32Array)||o.mvpMatrix.length!==16||!(o.viewMatrix instanceof Float32Array)||o.viewMatrix.length!==16||!Array.isArray(o.cameraPosition)||i===null||typeof i!="object")throw new TypeError("Studio backdrop export requires exact matrices, the camera position, and the pane backdrop.");if(!Number.isFinite(t?.width)||t.width<=0||!Number.isFinite(t?.height)||t.height<=0)throw new TypeError("Studio backdrop export requires a positive plot rectangle.");if(!Array.isArray(n?.rgb)||n.rgb.length!==3||typeof n.viewerPaper!="boolean")throw new TypeError("Studio backdrop export requires the resolved figure surface.");let c=e.palette,s=Ut(c.ink),l=Ut(c.glow),h=n.rgb,d=o.mvpMatrix,u=o.cameraPosition,m=i.pixelRatio,A=Lt({renderState:o,plotRect:t,crop:r}),{viewportW:y,viewportH:b,srcX0:T,srcY0:_,srcW:g,srcH:w,scale:C}=A,E=_i(d);if(E===null)return null;let L=i.glowCenterX,z=Math.max(1-L,.001),P=n.viewerPaper,F=en(i.planarity,{}),R=F.floor,$=on(d,u,i,{}),D=$.gate*c.poolAlpha*R,B=$.axisAX*$.axisBY-$.axisBX*$.axisAY,I=a((M,j)=>{let W=M/y*2-1,Z=1-j/b*2,J=h;if(P){let Y=Math.hypot((W-L)/z,Z);J=Ao(J,l,lo(Y))}if(D>0){let Y=W-$.centerX,Q=Z-$.centerY,de=($.axisBY*Y-$.axisBX*Q)/B,Ee=(-$.axisAY*Y+$.axisAX*Q)/B;J=Ao(J,s,lo(Math.hypot(de,Ee))*D)}return J},"baseAt"),k=a(M=>Math.max(Math.abs(s[0]-M[0]),Math.abs(s[1]-M[1]),Math.abs(s[2]-M[2])),"contrastAt"),U=a((M,j)=>M[0]*j[0]+M[1]*j[1]+M[2]*j[2],"dot3"),V=[];if(R>0&&V.push({normal:[0,1,0],offset:i.floorY,u:[1,0,0],v:[0,0,1],weight:R,lineMix:1,dotMix:0,surface:Do.floor,floor:!0}),F.backdrop>0){let M=tn(o.viewMatrix,i,{});V.push({normal:[M.normalX,M.normalY,M.normalZ],offset:M.offset,u:[M.uX,M.uY,M.uZ],v:[M.vX,M.vY,M.vZ],weight:F.backdrop,lineMix:0,dotMix:1,surface:Do.backdrop,floor:!1})}let H=a((M,j,W)=>[M.normal[0]*M.offset+M.u[0]*j+M.v[0]*W,M.normal[1]*M.offset+M.u[1]*j+M.v[1]*W,M.normal[2]*M.offset+M.u[2]*j+M.v[2]*W],"pointOn"),ce=a((M,j)=>{let W=j[0]-u[0],Z=j[1]-u[1],J=j[2]-u[2],Y=Math.hypot(W,Z,J);if(!(Y>0))return 0;if(M.floor)return M.weight*Qr(Math.hypot(j[0]-i.stageX,j[2]-i.stageZ))*fo(-Z/Y)*uo(u[1]-M.offset);let Q=M.offset-U(M.normal,u),de=U(M.normal,[W,Z,J]);return Q*de<0?0:M.weight*fo(Math.abs(de)/Y)*uo(Math.abs(Q))},"fadeAt"),re=a((M,j)=>{let W=1e-4*Math.max(1,Math.hypot(j[0]-u[0],j[1]-u[1],j[2]-u[2])),Z=A.clipToViewport(Qe(d,j)),J=j.map((fe,ye)=>fe+M.u[ye]*W),Y=j.map((fe,ye)=>fe+M.v[ye]*W),Q=A.clipToViewport(Qe(d,J)),de=A.clipToViewport(Qe(d,Y));if(Z===null||Q===null||de===null)return null;let Ee=(Q.x-Z.x)/W,Oe=(Q.y-Z.y)/W,ae=(de.x-Z.x)/W,se=(de.y-Z.y)/W,ke=Math.abs(Ee*se-ae*Oe);if(!(ke>0))return null;let _e=Math.max(Math.hypot(ae,se)/ke,Math.hypot(Ee,Oe)/ke);return{screen:Z,footprint:_e,level:Jr(M.surface,_e,m)}},"footprintAt"),xe=[],Ce=[];for(let M of V){let j=[];for(let ae=0;ae<=dr;ae++)for(let se=0;se<=ur;se++){let ke=T+g*se/ur,_e=_+w*ae/dr,fe=ke/y*2-1,ye=1-_e/b*2,Ae=[E[0]*fe+E[4]*ye+E[8]+E[12],E[1]*fe+E[5]*ye+E[9]+E[13],E[2]*fe+E[6]*ye+E[10]+E[14],E[3]*fe+E[7]*ye+E[11]+E[15]];if(!(Math.abs(Ae[3])>0))continue;let Xe=[Ae[0]/Ae[3]-u[0],Ae[1]/Ae[3]-u[1],Ae[2]/Ae[3]-u[2]],Me=U(M.normal,Xe);if(Math.abs(Me)<1e-12)continue;let Ie=(M.offset-U(M.normal,u))/Me;if(!(Ie>0))continue;let Be=[u[0]+Xe[0]*Ie,u[1]+Xe[1]*Ie,u[2]+Xe[2]*Ie];if(ce(M,Be)<=0)continue;let he=re(M,Be);he!==null&&j.push({u:U(Be,M.u),v:U(Be,M.v),footprint:he.footprint,visibleFrom:Math.ceil(Math.log(Ge.fadeInFraction*M.surface.minCellCssPx*m*he.footprint/Ge.base)/Zn-1e-9)})}if(j.length===0)continue;let W=1/0,Z=1/0,J=-1/0,Y=1/0,Q=-1/0;for(let ae of j)W=Math.min(W,ae.visibleFrom),Z=Math.min(Z,ae.u),J=Math.max(J,ae.u),Y=Math.min(Y,ae.v),Q=Math.max(Q,ae.v);let de=M.floor?2*De.outerRadius:Math.max(J-Z,Q-Y),Ee=Math.max(W,Math.ceil(Math.log(Math.max(de,Ge.base)/Ge.base)/Zn)+1),Oe=Math.max(g/ur,w/dr);for(let ae=W;ae<=Ee;ae++){let se=Uo(ae),ke=1/0,_e=-1/0,fe=1/0,ye=-1/0,Ae=0;for(let ge of j)ge.visibleFrom>ae||(ke=Math.min(ke,ge.u),_e=Math.max(_e,ge.u),fe=Math.min(fe,ge.v),ye=Math.max(ye,ge.v),Ae=Math.max(Ae,1.5*Oe*ge.footprint));if(!(_e>=ke))continue;ke-=Ae,_e+=Ae,fe-=Ae,ye+=Ae,M.floor&&(ke=Math.max(ke,i.stageX-De.outerRadius),_e=Math.min(_e,i.stageX+De.outerRadius),fe=Math.max(fe,i.stageZ-De.outerRadius),ye=Math.min(ye,i.stageZ+De.outerRadius));let Xe=Math.ceil(ke/se),Me=Math.floor(_e/se),Ie=Math.ceil(fe/se),Be=Math.floor(ye/se);if(Me<Xe||Be<Ie)continue;let he=ae===Ee,me=a(ge=>he||ge%Ge.ratio!==0,"ownsIndex");if(M.lineMix>0)for(let[ge,pe,Ze,ee,q]of[[!0,Xe,Me,fe,ye],[!1,Ie,Be,ke,_e]])for(let te=pe;te<=Ze;te++){if(!me(te))continue;let we=te*se,qe=ae+hr(te);ze(M,ge,we,qe,ee,q)}if(M.dotMix>0){let ge=[],pe=0;for(let ee of j){if(ee.visibleFrom>ae)continue;let q=1.5*Oe*ee.footprint,te=Math.max(Xe,Math.ceil((ee.u-q)/se)),we=Math.min(Me,Math.floor((ee.u+q)/se)),qe=Math.max(Ie,Math.ceil((ee.v-q)/se)),nt=Math.min(Be,Math.floor((ee.v+q)/se));we<te||nt<qe||(ge.push(te,we,qe,nt),pe+=(we-te+1)*(nt-qe+1))}let Ze=a((ee,q)=>{let te=hr(ee);for(let we of q)!he&&te>0&&we%Ge.ratio===0||Ne(M,ee*se,we*se,ae+Math.min(te,hr(we)))},"emitRow");if((Me-Xe+1)*(Be-Ie+1)<=pe){let ee=[];for(let q=Ie;q<=Be;q++)ee.push(q);for(let q=Xe;q<=Me;q++)Ze(q,ee)}else{let ee=new Map;for(let te=0;te<ge.length;te+=4)for(let we=ge[te];we<=ge[te+1];we++){let qe=ee.get(we);qe===void 0&&(qe=new Set,ee.set(we,qe));for(let nt=ge[te+2];nt<=ge[te+3];nt++)qe.add(nt)}let q=a((te,we)=>te-we,"ascending");for(let te of[...ee.keys()].sort(q))Ze(te,[...ee.get(te)].sort(q))}}}}function ze(M,j,W,Z,J,Y){let Q=J,de=Y;if(M.floor){let pe=j?i.stageX:i.stageZ,Ze=j?i.stageZ:i.stageX,ee=De.outerRadius**2-(W-pe)**2;if(!(ee>0))return;let q=Math.sqrt(ee);Q=Math.max(Q,Ze-q),de=Math.min(de,Ze+q)}if(!(de>Q))return;let Ee=a(pe=>j?H(M,W,pe):H(M,pe,W),"pointAt"),Oe=Ee(Q),ae=Ee(de),se=_o(Qe(d,Oe),Qe(d,ae));if(se===null)return;let ke=yt(Oe,ae,se[0]),_e=yt(Oe,ae,se[1]),fe=[],ye=0,Ae=0,Xe=!1;for(let pe=0;pe<=Yn;pe++){let Ze=yt(ke,_e,pe/Yn),ee=re(M,Ze);if(ee===null)return;let q=jo({coarsestLevel:Z,level:ee.level,footprint:ee.footprint,pixelRatio:m,surface:M.surface,minorAlpha:c.lineMinorAlpha,majorAlpha:c.lineMajorAlpha}),te=ce(M,Ze)*M.lineMix*q.strength,we=I(ee.screen.x,ee.screen.y);te*k(we)>=Vn&&(Xe=!0),te>ye&&(ye=te,Ae=q.majorness),fe.push({plot:A.viewportToPlot(ee.screen.x,ee.screen.y),color:lt(Ao(we,s,te))})}if(!Xe)return;let Me=fe[0].plot,Ie=fe[fe.length-1].plot,Be=Ie.x-Me.x,he=Ie.y-Me.y,me=Be*Be+he*he;if(!(me>0))return;let ge=mt.lineWidthCssPx+(mt.majorLineWidthCssPx-mt.lineWidthCssPx)*Ae;xe.push({x1:Me.x,y1:Me.y,x2:Ie.x,y2:Ie.y,widthPx:ge*m*C,stops:fe.map(pe=>({offset:Math.min(1,Math.max(0,((pe.plot.x-Me.x)*Be+(pe.plot.y-Me.y)*he)/me)),color:pe.color}))})}a(ze,"emitRule");function Ne(M,j,W,Z){let J=H(M,j,W),Y=re(M,J);if(Y===null)return;let Q=mt.majorDotRadiusCssPx*m;if(Y.screen.x<T-Q||Y.screen.x>T+g+Q||Y.screen.y<_-Q||Y.screen.y>_+w+Q)return;let de=jo({coarsestLevel:Z,level:Y.level,footprint:Y.footprint,pixelRatio:m,surface:M.surface,minorAlpha:c.dotMinorAlpha,majorAlpha:c.dotMajorAlpha}),Ee=ce(M,J)*M.dotMix*de.strength,Oe=I(Y.screen.x,Y.screen.y);if(Ee*k(Oe)<Vn)return;let ae=mt.dotRadiusCssPx+(mt.majorDotRadiusCssPx-mt.dotRadiusCssPx)*de.majorness,se=A.viewportToPlot(Y.screen.x,Y.screen.y);Ce.push({cx:se.x,cy:se.y,r:ae*m*C,color:lt(Ao(Oe,s,Ee))})}a(Ne,"emitDot");let $e=.5*y*C,He=-.5*b*C,We=a((M,j,W,Z,J,Y)=>{let Q=A.viewportToPlot((M*.5+.5)*y,(.5-j*.5)*b);return[W*$e,Z*He,J*$e,Y*He,Q.x,Q.y]},"ellipseMatrix"),Ye=a((M,j)=>{let W=[];for(let Z=0;Z<=Kn;Z++){let J=Z/Kn;W.push({offset:J,color:M,opacity:lo(J)*j})}return W},"falloffStops"),Se=[];return P&&Se.push({matrix:We(L,0,z,0,0,1),stops:Ye(lt(l),1)}),D>0&&Se.push({matrix:We($.centerX,$.centerY,$.axisAX,$.axisAY,$.axisBX,$.axisBY),stops:Ye(lt(s),D)}),Se.length===0&&xe.length===0&&Ce.length===0?null:{kind:"studio",rect:{x:t.x,y:t.y,width:t.width,height:t.height},gradients:Se,segments:xe,dots:Ce}}a(Jn,"buildStudioBackdropModel");function qn(e){return e.map(o=>`<stop offset="${o.offset.toFixed(4)}" stop-color="${o.color}"`+(o.opacity===void 0?"":` stop-opacity="${o.opacity.toFixed(5)}"`)+"/>").join("")}a(qn,"formatStops");function Qn(e,o){if(typeof o!="string"||!/^[A-Za-z][\w-]*$/.test(o))throw new TypeError("Studio backdrop SVG requires an exact element-id prefix.");let t=[],r=[],{rect:n}=e;if(e.gradients.forEach((i,c)=>{let s=`${o}-tone-${c}`;t.push(`<radialGradient id="${s}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${i.matrix.map(l=>l.toFixed(4)).join(" ")})">${qn(i.stops)}</radialGradient>`),r.push(`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="url(#${s})"/>`)}),e.segments.length>0&&(r.push('<g fill="none" stroke-linecap="butt">'),e.segments.forEach((i,c)=>{let s=`${o}-rule-${c}`;t.push(`<linearGradient id="${s}" gradientUnits="userSpaceOnUse" x1="${i.x1.toFixed(2)}" y1="${i.y1.toFixed(2)}" x2="${i.x2.toFixed(2)}" y2="${i.y2.toFixed(2)}">${qn(i.stops)}</linearGradient>`),r.push(`<line x1="${i.x1.toFixed(2)}" y1="${i.y1.toFixed(2)}" x2="${i.x2.toFixed(2)}" y2="${i.y2.toFixed(2)}" stroke="url(#${s})" stroke-width="${i.widthPx.toFixed(3)}"/>`)}),r.push("</g>")),e.dots.length>0){r.push('<g stroke="none">');for(let i of e.dots)r.push(`<circle cx="${i.cx.toFixed(2)}" cy="${i.cy.toFixed(2)}" r="${i.r.toFixed(3)}" fill="${i.color}"/>`);r.push("</g>")}return'<g class="cellucid-studio-backdrop">'+(t.length>0?`<defs>${t.join("")}</defs>`:"")+r.join("")+"</g>"}a(Qn,"renderSvgStudioBackdrop");function Ai(e,o){if(o===void 0)return e;let t=Number.parseInt(e.slice(1),16);return`rgba(${t>>16&255}, ${t>>8&255}, ${t&255}, ${o})`}a(Ai,"canvasColor");function ea({ctx:e,model:o}){e.save();let{rect:t}=o;for(let r of o.gradients){e.save(),e.beginPath(),e.rect(t.x,t.y,t.width,t.height),e.transform(...r.matrix);let n=e.createRadialGradient(0,0,0,0,0,1);for(let i of r.stops)n.addColorStop(i.offset,Ai(i.color,i.opacity));e.fillStyle=n,e.fill(),e.restore()}e.lineCap="butt";for(let r of o.segments){let n=e.createLinearGradient(r.x1,r.y1,r.x2,r.y2);for(let i of r.stops)n.addColorStop(i.offset,i.color);e.beginPath(),e.moveTo(r.x1,r.y1),e.lineTo(r.x2,r.y2),e.strokeStyle=n,e.lineWidth=r.widthPx,e.stroke()}for(let r of o.dots)e.beginPath(),e.arc(r.cx,r.cy,r.r,0,Math.PI*2),e.fillStyle=r.color,e.fill();e.restore()}a(ea,"drawCanvasStudioBackdrop");var Mi=.35,Ti=.16,Si=.6,ki=.58,Ri=.5,Ci=.18,$i=.65,Oi=.32,Fi=.03,Li=.55,Pi=.55,pr=Object.freeze([.2126,.7152,.0722]),zi=5,Ni=.5,Ii=.5*1.2,Di=1.4,Bi=1.55,Ui=-.2,ji=.05,Gi=.01,Xi=Object.freeze(["x","y","z"]),Hi=Object.freeze([Object.freeze({key:"bottom",fixedAxis:1,fixedSign:-1,axisA:0,axisB:2}),Object.freeze({key:"top",fixedAxis:1,fixedSign:1,axisA:0,axisB:2}),Object.freeze({key:"back",fixedAxis:2,fixedSign:-1,axisA:0,axisB:1}),Object.freeze({key:"front",fixedAxis:2,fixedSign:1,axisA:0,axisB:1}),Object.freeze({key:"left",fixedAxis:0,fixedSign:-1,axisA:1,axisB:2}),Object.freeze({key:"right",fixedAxis:0,fixedSign:1,axisA:1,axisB:2})]),Wi=0,Yi=1,Ki=2,Vi=3;function Zi(e,o,t){let r=Math.max(0,Math.min(1,(t-e)/(o-e)));return r*r*(3-2*r)}a(Zi,"smoothstep");function mr(e,o,t){return[e[0]+(o[0]-e[0])*t,e[1]+(o[1]-e[1])*t,e[2]+(o[2]-e[2])*t]}a(mr,"mixRgb");function Pt(e,o){if(!Array.isArray(e)&&!(e instanceof Float32Array)||e.length!==3||Array.from(e).some(t=>!Number.isFinite(t)||t<0||t>1))throw new TypeError(`${o} must contain exactly three 0..1 numbers.`);return[e[0],e[1],e[2]]}a(Pt,"assertRgb01");function qi(e,o){let t=Math.round(e/o);if(t<1||Math.abs(t*o-e)>1e-6)throw new RangeError("Reference grid spacing must divide the grid half-extent exactly.");let r=[];for(let n=-t;n<=t;n++){let i=n===0,c=Math.abs(n)===t,s=n%zi===0,l=Wi;i?l=Vi:c?l=Ki:s&&(l=Yi),r.push({coordinate:n*o,minor:!0,major:s,frame:c,origin:i,rank:l})}return r}a(qi,"enumerateRuleCoordinates");function Ji({rule:e,strengths:o,lineWidth:t,lineColor:r,axisColor:n,surfaceRgb:i,effectiveOpacity:c}){let s=[{half:Ni,strength:o.minor,axis:!1}];e.major&&s.push({half:Ii,strength:o.major,axis:!1}),e.frame&&s.push({half:Di,strength:o.frame,axis:!1}),e.origin&&s.push({half:Bi,strength:o.axis,axis:!0});let l=[...new Set(s.map(d=>d.half))].sort((d,u)=>u-d),h=[];for(let d of l){let u=0,m=0;for(let b of s)b.half<d||(b.axis?m=b.strength:u+=b.strength);if(u=Math.min(1,u),u<=0&&m<=0)continue;let A=mr(i,r,u);m>0&&(A=mr(A,n,m));let y=mr(i,A,c);h.push({halfWidthWorld:d*t,color:lt(y)})}return h}a(Ji,"buildRuleBands");function Gl({appearance:e,background:o,backgroundColor:t}){if(e==null)return null;let r=[e.surfaceColor[0],e.surfaceColor[1],e.surfaceColor[2]];if(o==="transparent")return Object.freeze({rgb:r,viewerPaper:!1});let n=$t(t);if(n===null)throw new TypeError("Reference grid export requires an exact #RRGGBB figure background.");return Object.freeze({rgb:n,viewerPaper:lt(n)===lt(r)})}a(Gl,"resolveReferenceGridSurface");function Xl({appearance:e,renderState:o,plotRect:t,crop:r=null,surface:n}){if(e==null||e.kind==="look")return null;if(e.kind==="studio")return Jn({appearance:e,renderState:o,plotRect:t,crop:r,surface:n});if(!(o?.mvpMatrix instanceof Float32Array)||o.mvpMatrix.length!==16||!(o.viewMatrix instanceof Float32Array)||o.viewMatrix.length!==16)throw new TypeError("Reference grid export requires exact 16-value MVP and view matrices.");if(!Number.isFinite(t?.width)||t.width<=0||!Number.isFinite(t?.height)||t.height<=0)throw new TypeError("Reference grid export requires a positive plot rectangle.");let i=Pt(n?.rgb,"Reference grid surface colour"),c=Pt(e.lineColor,"Reference grid line colour"),s={x:Pt(e.axisColors.x,"Reference grid X-axis colour"),y:Pt(e.axisColors.y,"Reference grid Y-axis colour"),z:Pt(e.axisColors.z,"Reference grid Z-axis colour")},l=Pt(e.surfaceColor,"Reference grid viewer surface colour"),d=l[0]*pr[0]+l[1]*pr[1]+l[2]*pr[2]>=Pi?1:0,u=e.size,m=e.spacing,A=e.lineWidth,y=e.opacity,b=o.mvpMatrix,T=o.viewMatrix,{toPlot:_}=Lt({renderState:o,plotRect:t,crop:r}),g=[-T[2],-T[6],-T[10]],w=qi(u,m),C=[],E=Math.max(t.width,t.height),L=t.x-E,z=t.x+t.width+E,P=t.y-E,F=t.y+t.height+E;for(let R of Hi){let $=[0,0,0];$[R.fixedAxis]=R.fixedSign;let D=g[0]*$[0]+g[1]*$[1]+g[2]*$[2],B=Zi(Ui,ji,D);if(B<Gi)continue;let I=y*B,k={minor:(Mi+Ti*d)*I**Si,major:ki*I**Ri,frame:Ci*I**$i,axis:(Oi+Fi*d)*I**Li},U=[];for(let[V,H]of[[R.axisA,R.axisB],[R.axisB,R.axisA]])for(let ce of w)U.push({rule:ce,constantAxis:V,runningAxis:H});U.sort((V,H)=>V.rule.rank-H.rule.rank);for(let{rule:V,constantAxis:H,runningAxis:ce}of U){let re=[0,0,0],xe=[0,0,0];re[R.fixedAxis]=R.fixedSign*u,xe[R.fixedAxis]=R.fixedSign*u,re[H]=V.coordinate,xe[H]=V.coordinate,re[ce]=-u,xe[ce]=u;let Ce=Qe(b,re),ze=Qe(b,xe),Ne=_o(Ce,ze);if(Ne===null)continue;let[$e,He]=Ne,We=yt(re,xe,$e),Ye=yt(re,xe,He),Se=_(Qe(b,We)),M=_(Qe(b,Ye));if(Se===null||M===null||Se.x<L&&M.x<L||Se.x>z&&M.x>z||Se.y<P&&M.y<P||Se.y>F&&M.y>F)continue;let j=yt(We,Ye,.5),W=s[Xi[ce]],Z=Ji({rule:V,strengths:k,lineWidth:A,lineColor:c,axisColor:W,surfaceRgb:i,effectiveOpacity:I});for(let J of Z){let Y=[...j],Q=[...j];Y[H]-=J.halfWidthWorld,Q[H]+=J.halfWidthWorld;let de=_(Qe(b,Y)),Ee=_(Qe(b,Q));if(de===null||Ee===null)continue;let Oe=Math.hypot(Ee.x-de.x,Ee.y-de.y);!Number.isFinite(Oe)||Oe<=0||C.push({x1:Se.x,y1:Se.y,x2:M.x,y2:M.y,widthPx:Oe,color:J.color})}}}return C.length===0?null:{kind:"grid",segments:C}}a(Xl,"buildReferenceGridModel");function Hl(e,o){if(e===null)return"";if(e.kind==="studio")return Qn(e,o);let t=['<g class="cellucid-reference-grid" fill="none" stroke-linecap="butt">'];for(let r of e.segments)t.push(`<line x1="${r.x1.toFixed(2)}" y1="${r.y1.toFixed(2)}" x2="${r.x2.toFixed(2)}" y2="${r.y2.toFixed(2)}" stroke="${r.color}" stroke-width="${r.widthPx.toFixed(3)}"/>`);return t.push("</g>"),t.join("")}a(Hl,"renderSvgReferenceGrid");function Wl({ctx:e,model:o}){if(o!==null){if(o.kind==="studio"){ea({ctx:e,model:o});return}e.save(),e.lineCap="butt";for(let t of o.segments)e.beginPath(),e.moveTo(t.x1,t.y1),e.lineTo(t.x2,t.y2),e.strokeStyle=t.color,e.lineWidth=t.widthPx,e.stroke();e.restore()}}a(Wl,"drawCanvasReferenceGrid");var oa=Object.freeze(["BLEND","CULL_FACE","DEPTH_TEST","DITHER","POLYGON_OFFSET_FILL","RASTERIZER_DISCARD","SAMPLE_ALPHA_TO_COVERAGE","SAMPLE_COVERAGE","SCISSOR_TEST","STENCIL_TEST"]),ta=new WeakMap;function Qi(e){let o=new Map,t=new Set;for(let s of oa)Number.isInteger(e[s])&&t.add(e[s]);let r=new Map,n=a((s,l)=>(r.has(s)||r.set(s,l()),r.get(s)),"read"),i=a((s,l)=>{let h=e[s];typeof h=="function"&&(e[s]=a(function(...u){let m=Reflect.apply(h,e,u);return l(...u),m},"shadowedSetter"))},"wrap");return i("enable",s=>{t.has(s)&&o.set(s,!0)}),i("disable",s=>{t.has(s)&&o.set(s,!1)}),i("activeTexture",s=>{r.set("activeTexture",s)}),i("viewport",(s,l,h,d)=>{r.set("viewport",Int32Array.of(s,l,h,d))}),i("scissor",(s,l,h,d)=>{r.set("scissorBox",Int32Array.of(s,l,h,d))}),i("colorMask",(s,l,h,d)=>{r.set("colorMask",[!!s,!!l,!!h,!!d])}),i("clearColor",(s,l,h,d)=>{r.set("clearColor",[Math.fround(s),Math.fround(l),Math.fround(h),Math.fround(d)])}),i("blendFunc",(s,l)=>{r.set("blendFunc",{srcRgb:s,dstRgb:l,srcAlpha:s,dstAlpha:l})}),i("blendFuncSeparate",(s,l,h,d)=>{r.set("blendFunc",{srcRgb:s,dstRgb:l,srcAlpha:h,dstAlpha:d})}),i("blendEquation",s=>{r.set("blendEquation",{rgb:s,alpha:s})}),i("blendEquationSeparate",(s,l)=>{r.set("blendEquation",{rgb:s,alpha:l})}),i("depthMask",s=>{r.set("depthMask",!!s)}),i("vertexAttrib4f",(s,l,h,d,u)=>{r.set(`generic${s}`,Float32Array.of(l,h,d,u))}),i("vertexAttribI4i",(s,l,h,d,u)=>{r.set(`generic${s}`,Int32Array.of(l,h,d,u))}),i("vertexAttribI4ui",(s,l,h,d,u)=>{r.set(`generic${s}`,Uint32Array.of(l,h,d,u))}),Object.freeze({isEnabled(s){if(!t.has(s))throw new RangeError(`The WebGL state shadow does not track capability 0x${Number(s).toString(16)}.`);return o.has(s)||o.set(s,e.isEnabled(s)===!0),o.get(s)},get activeTexture(){return n("activeTexture",()=>e.getParameter(e.ACTIVE_TEXTURE))},get viewport(){return Int32Array.from(n("viewport",()=>Int32Array.from(e.getParameter(e.VIEWPORT))))},get scissorBox(){return Int32Array.from(n("scissorBox",()=>Int32Array.from(e.getParameter(e.SCISSOR_BOX))))},get colorMask(){return[...n("colorMask",()=>Array.from(e.getParameter(e.COLOR_WRITEMASK),Boolean))]},get clearColor(){return[...n("clearColor",()=>Array.from(e.getParameter(e.COLOR_CLEAR_VALUE)))]},get blendFunc(){return{...n("blendFunc",()=>({srcRgb:e.getParameter(e.BLEND_SRC_RGB),dstRgb:e.getParameter(e.BLEND_DST_RGB),srcAlpha:e.getParameter(e.BLEND_SRC_ALPHA),dstAlpha:e.getParameter(e.BLEND_DST_ALPHA)}))}},get blendEquation(){return{...n("blendEquation",()=>({rgb:e.getParameter(e.BLEND_EQUATION_RGB),alpha:e.getParameter(e.BLEND_EQUATION_ALPHA)}))}},get depthMask(){return n("depthMask",()=>e.getParameter(e.DEPTH_WRITEMASK)===!0)},genericAttribute(s){let l=r.get(`generic${s}`)??Float32Array.of(0,0,0,1);return new l.constructor(l)}})}a(Qi,"createShadow");function Vl(e){let o=br(e);for(let t of oa)Number.isInteger(e[t])&&o.isEnabled(e[t]);for(let t of["activeTexture","viewport","scissorBox","colorMask","clearColor","blendFunc","blendEquation","depthMask"])o[t]}a(Vl,"primeGlState");function br(e){let o=ta.get(e);return o===void 0&&(o=Qi(e),ta.set(e,o)),o}a(br,"glStateOf");var At=`#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform vec4 u_ndcTransform;
out vec2 v_ndc;
void main() {
  v_ndc = a_corner * u_ndcTransform.xy + u_ndcTransform.zw;
  gl_Position = vec4(a_corner, 1.0, 1.0);
}
`,ra=`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
vec3 noiseGrad(vec3 c, vec2 per) {
  c.xy = mod(c.xy, per);
  return hash33(c) * 2.0 - 1.0;
}
// Gradient noise, about -1..1, periodic in x and y with period per.
float gnoise(vec3 p, vec2 per) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(noiseGrad(i, per), f);
  float n100 = dot(noiseGrad(i + vec3(1, 0, 0), per), f - vec3(1, 0, 0));
  float n010 = dot(noiseGrad(i + vec3(0, 1, 0), per), f - vec3(0, 1, 0));
  float n110 = dot(noiseGrad(i + vec3(1, 1, 0), per), f - vec3(1, 1, 0));
  float n001 = dot(noiseGrad(i + vec3(0, 0, 1), per), f - vec3(0, 0, 1));
  float n101 = dot(noiseGrad(i + vec3(1, 0, 1), per), f - vec3(1, 0, 1));
  float n011 = dot(noiseGrad(i + vec3(0, 1, 1), per), f - vec3(0, 1, 1));
  float n111 = dot(noiseGrad(i + vec3(1, 1, 1), per), f - vec3(1, 1, 1));
  return 1.7 * mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}
// Fractal sum; every octave doubles the frequency and the period, so a
// periodic input stays periodic.
float fbm(vec3 p, vec2 per, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= octaves) break;
    sum += amp * gnoise(p, per);
    norm += amp;
    p = vec3(p.xy * 2.0, p.z * 2.0 + 1.31);
    per *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
float ridged(vec3 p, vec2 per, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  float prev = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(gnoise(p, per));
    n *= n;
    sum += amp * n * prev;
    prev = clamp(n * 1.6, 0.0, 1.0);
    norm += amp;
    p = vec3(p.xy * 2.0, p.z * 2.0 + 0.77);
    per *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
`,na=`
vec3 cubeFaceDir(int face, vec2 uv) {
  if (face == 0) return vec3(1.0, -uv.y, -uv.x);
  if (face == 1) return vec3(-1.0, -uv.y, uv.x);
  if (face == 2) return vec3(uv.x, 1.0, uv.y);
  if (face == 3) return vec3(uv.x, -1.0, -uv.y);
  if (face == 4) return vec3(uv.x, -uv.y, 1.0);
  return vec3(-uv.x, -uv.y, -1.0);
}
// Inverse of cubeFaceDir: the face and its uv (-1..1) of a direction.
int cubeFaceOf(vec3 d, out vec2 uv) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    uv = d.x > 0.0 ? vec2(-d.z, -d.y) / a.x : vec2(d.z, -d.y) / a.x;
    return d.x > 0.0 ? 0 : 1;
  }
  if (a.y >= a.z) {
    uv = d.y > 0.0 ? vec2(d.x, d.z) / a.y : vec2(d.x, -d.z) / a.y;
    return d.y > 0.0 ? 2 : 3;
  }
  uv = d.z > 0.0 ? vec2(d.x, -d.y) / a.z : vec2(-d.x, -d.y) / a.z;
  return d.z > 0.0 ? 4 : 5;
}
`,aa=`
// x: present (0/1), y: magnitude 0..1, z: colour temperature 0..1; dir out.
vec3 starInCell(int face, vec2 cell, float cells, float probability, float seed, out vec3 dir) {
  vec3 key = vec3(cell, float(face) * 131.0 + seed);
  float h = hash13(key);
  vec2 jitter = 0.25 + 0.5 * hash22(cell + vec2(float(face) * 17.0 + seed, seed * 3.1));
  vec2 st = (cell + jitter) / cells;
  vec2 uv = st * 2.0 - 1.0;
  dir = normalize(cubeFaceDir(face, uv));
  float present = step(h, probability);
  float magnitude = hash13(key + 19.7);
  return vec3(present, magnitude, hash13(key + 5.3));
}
vec3 starTint(float temperature) {
  return mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.80, 0.58), temperature);
}
`,xr=`#version 300 es
precision highp float;
uniform int u_face;      // cube face 0..5, or -1 for the periodic tile
uniform float u_size;    // texels per side
out vec4 fragColor;
${ra}
${na}
${aa}
`,es=`${xr}
const vec3 BAND_NORMAL = vec3(0.3283, 0.8536, -0.4048);
const float BRIGHT_CELLS = 40.0;

// Halos of the bright stars around a direction: the 3x3 cells of its face.
float starHalos(vec3 d) {
  vec2 uv;
  int face = cubeFaceOf(d, uv);
  vec2 st = uv * 0.5 + 0.5;
  vec2 base = floor(st * BRIGHT_CELLS);
  float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
  float halo = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = base + vec2(x, y);
      if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= BRIGHT_CELLS || cell.y >= BRIGHT_CELLS) continue;
      vec3 sd;
      vec3 star = starInCell(face, cell, BRIGHT_CELLS, 0.05 + 0.16 * band, 3.0, sd);
      if (star.x < 0.5) continue;
      float m = pow(star.y, 5.0);
      float ang = length(sd - d);
      float sigma = 0.0035 + 0.006 * m;
      halo += m * (exp(-ang * ang / (sigma * sigma)) * 2.4
        + 0.10 / (1.0 + pow(ang / (0.010 + 0.02 * m), 2.0)));
    }
  }
  return halo;
}

vec4 nebulaField(vec3 p, vec2 per, float band) {
  vec3 w = vec3(
    fbm(p + vec3(3.1, 7.7, 1.3), per, 5),
    fbm(p + vec3(8.4, 2.2, 5.9), per, 5),
    fbm(p + vec3(1.9, 4.6, 9.3), per, 5)
  );
  vec3 pw = p + w * 1.15;
  float large = fbm(pw, per, 7);
  float cloudA = smoothstep(-0.10, 0.70, large + band * 0.38 - 0.08);
  cloudA *= cloudA;
  float second = fbm(vec3(pw.xy * 2.0, pw.z * 2.0) + vec3(11.1, 3.3, 7.7), per * 2.0, 6);
  float cloudB = smoothstep(-0.05, 0.6, second) * smoothstep(-0.45, 0.35, large);
  float filaments = ridged(vec3(pw.xy * 3.0, pw.z * 3.0) + vec3(5.0, 1.0, 2.0), per * 3.0, 6);
  filaments = pow(filaments, 3.0) * smoothstep(-0.35, 0.45, large);
  float dustNoise = fbm(vec3(p.xy * 2.0, p.z * 2.0) + w * 1.6 + vec3(4.2, 0.4, 2.9), per * 2.0, 7);
  float dust = smoothstep(0.02, 0.5, dustNoise) * (0.4 + 0.6 * band);
  return vec4(cloudA, clamp(cloudB * 0.75 + filaments * 1.4, 0.0, 2.0), dust, 0.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    // Periodic tile for the near layer of planar panes: wisps and dust.
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.37);
    vec4 field = nebulaField(p, per, 0.3);
    fragColor = vec4(clamp(field.r, 0.0, 1.0), clamp(field.g * 0.5, 0.0, 1.0), field.b, 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
  vec4 field = nebulaField(d * 2.1, vec2(1e4), band);
  // RGBA8: filaments (0..2) stored halved, halo glow (HDR) as g / (1 + g).
  float halo = starHalos(d);
  fragColor = vec4(field.r, clamp(field.g * 0.5, 0.0, 1.0), field.b, halo / (1.0 + halo));
}
`,ts=`${xr}
const vec3 SUN = vec3(0.2357, 0.9428, 0.2357);

// Shafts: noise around the sun axis, so every shaft converges on the sun.
vec4 abyssSky(vec3 d) {
  vec3 t1 = normalize(cross(SUN, vec3(0.0, 0.0, 1.0)));
  vec3 t2 = cross(SUN, t1);
  float ang = acos(clamp(dot(d, SUN), -1.0, 1.0));
  vec2 around = normalize(vec2(dot(d, t1), dot(d, t2)) + 1e-6);
  vec2 per = vec2(1e4);
  // Shaft pattern: noise on a circle, stretched along the shaft.
  float broad = fbm(vec3(around * 3.2, ang * 0.35), per, 4);
  float fine = fbm(vec3(around * 11.0, ang * 0.6 + 4.0), per, 4);
  float shaftsBroad = smoothstep(0.0, 0.55, broad);
  float shaftsFine = smoothstep(0.05, 0.6, fine);
  // Shafts fade away from the sun and break up along their length.
  float along = 0.6 + 0.4 * fbm(d * 3.0 + vec3(2.0, 7.0, 1.0), per, 3);
  float fade = exp(-ang * 1.15);
  // Caustic net near the surface: ridged noise on the plane above.
  float caustic = 0.0;
  if (d.y > 0.05) {
    vec2 plane = d.xz / d.y;
    caustic = pow(ridged(vec3(plane * 2.4, 0.5), per, 4), 3.0) * smoothstep(0.05, 0.6, d.y);
  }
  float murk = fbm(d * 1.6 + vec3(9.0, 3.0, 5.0), per, 6);
  return vec4(
    shaftsBroad * fade * along,
    caustic,
    murk * 0.5 + 0.5,
    shaftsFine * fade * along
  );
}

// A periodic caustic web: the bright borders of a domain-warped cellular
// pattern with "cells" cells per tile side.
float causticWeb(vec2 st, float cells) {
  vec2 per = vec2(cells);
  vec2 p = st * cells;
  vec2 w = p + 0.38 * vec2(gnoise(vec3(p, 1.3), per), gnoise(vec3(p, 7.1), per));
  vec2 i = floor(w);
  vec2 f = w - i;
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = hash22(mod(i + o, per) + 0.5);
      vec2 r = o + 0.5 + 0.42 * sin(6.2831 * h) - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return exp(-(sqrt(f2) - sqrt(f1)) * 10.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.61);
    float murk = fbm(p, per, 6) * 0.5 + 0.5;
    fragColor = vec4(murk, causticWeb(st, 8.0), causticWeb(st + 0.37, 5.0), 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  fragColor = clamp(abyssSky(d), 0.0, 1.0);
}
`,os=`${xr}
const vec3 SUN = vec3(0.7894, 0.1105, -0.6039);

float cloudDensity(vec3 p, vec2 per) {
  // Offset so the field is not centred on a gap: the sky straight overhead
  // (all a camera below the data sees) carries clouds too.
  p += vec3(4.7, 0.0, 2.3);
  float base = fbm(p * vec3(0.55, 1.4, 0.55), per, 6);
  float detail = fbm(p * 1.9 + vec3(3.0, 1.0, 7.0), per, 4);
  return clamp((base * 0.85 + detail * 0.25 + 0.13) * 2.4, 0.0, 1.0);
}

// The upper clouds: a slab between heights 1.0 and 1.35, ray-marched.
vec2 upperClouds(vec3 d) {
  if (d.y < 0.015) return vec2(0.0, 0.0);
  vec2 per = vec2(1e4);
  float t0 = 1.0 / d.y;
  float t1 = 1.35 / d.y;
  float steps = 10.0;
  float dt = (t1 - t0) / steps;
  float transmittance = 1.0;
  float light = 0.0;
  for (int i = 0; i < 10; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = d * t;
    float far = smoothstep(4.0, 22.0, t);
    float dens = cloudDensity(p * 1.6, per) * (1.0 - far * 0.75);
    if (dens < 0.01) continue;
    float toward = cloudDensity(p * 1.6 + SUN * 0.3, per);
    float lit = exp(-toward * 2.2) * 0.85 + 0.15;
    float absorb = 1.0 - exp(-dens * dt * 7.0);
    light += transmittance * absorb * lit;
    transmittance *= 1.0 - absorb;
    if (transmittance < 0.02) break;
  }
  float opacity = (1.0 - transmittance) * smoothstep(0.015, 0.12, d.y);
  return vec2(opacity, opacity > 1e-3 ? light / (1.0 - transmittance) : 0.0);
}

// Aurora curtains: luminous vertical sheets hanging between two heights,
// whose ground tracks are wavy curves, ray-marched from below so their
// folds and rays read in true perspective. x: emission, y: mean height
// fraction (0 at the bright lower edge, 1 at the top).
vec2 curtains(vec3 d) {
  if (d.y < 0.02) return vec2(0.0);
  vec2 per = vec2(1e4);
  const float BASE = 1.7;
  const float TOP = 3.6;
  float t0 = BASE / d.y;
  float t1 = TOP / d.y;
  float dt = (t1 - t0) / 24.0;
  float glow = 0.0;
  float heightSum = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = d * t;
    float h = (p.y - BASE) / (TOP - BASE);
    float sheet = 0.0;
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float z0 = k == 0 ? -1.4 : (k == 1 ? -5.5 : 4.0);
      float curve = z0
        + 1.5 * sin(p.x * 0.33 + fk * 2.1)
        + 1.3 * fbm(vec3(p.x * 0.22, fk * 4.0, 0.5), per, 2);
      float dist = abs(p.z - curve);
      float width = 0.10 + 0.015 * t;
      float rays = 0.25 + 0.75 * smoothstep(-0.25, 0.6, fbm(vec3(p.x * 5.0 + fk * 9.0, fk * 3.0, h * 0.7), per, 3));
      sheet += exp(-dist * dist / (width * width)) * rays * (1.0 - 0.25 * fk);
    }
    float profile = exp(-h * 2.4) * (1.0 - exp(-h * 30.0));
    float e = sheet * profile * dt;
    glow += e;
    heightSum += e * h;
  }
  float fade = smoothstep(0.02, 0.14, d.y);
  return vec2(clamp(glow * 5.0, 0.0, 1.0) * fade, glow > 1e-4 ? heightSum / glow : 0.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    // Periodic cloud tile: density, top-lit shading, a second layer.
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.29);
    float dens = clamp(fbm(p, per, 7) * 1.9 + 0.12, 0.0, 1.0);
    float lit = clamp(0.55 + (dens - clamp(fbm(p + vec3(0.06, 0.09, 0.0), per, 7) * 1.9 + 0.12, 0.0, 1.0)) * 6.0, 0.0, 1.0);
    float second = clamp(fbm(vec3(st * per * 2.0, 3.7), per * 2.0, 6) * 1.8 + 0.05, 0.0, 1.0);
    fragColor = vec4(dens, lit, second, 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  vec2 clouds = upperClouds(d);
  vec2 aurora = curtains(d);
  fragColor = vec4(clouds, aurora);
}
`,Mo=`#version 300 es
precision highp float;
in vec2 v_ndc;
uniform mat4 u_invMvp;        // pane NDC -> model space
uniform vec3 u_eye;           // camera, model space
uniform float u_pixelRatio;   // device px per CSS px
uniform vec2 u_viewport;      // pane size, device px
uniform float u_glowCenterX;  // NDC x of the presented area's centre
uniform float u_opacity;      // fade-in 0..1
uniform vec3 u_surface;       // clear colour (sRGB)
uniform float u_planar;       // 1: planar pane (virtual sky camera + near tile)
uniform vec3 u_stageCenter;
uniform vec3 u_stageExtent;
uniform float u_floorY;
uniform float u_time;         // ambient clock, seconds (frozen when still)
uniform float u_ambient;      // 1 while ambient motion runs
uniform float u_dark;         // 1: dark twin
uniform vec3 u_tint0;         // data tints, linear, luminance 1
uniform vec3 u_tint1;
uniform vec3 u_tint2;
out vec4 fragColor;
${ra}
${na}
${aa}

vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Soft knee on luminance: large areas can approach but never pass cap.
vec3 kneeLuminance(vec3 c, float cap) {
  float y = luma(c);
  float target = cap * (1.0 - exp(-y / cap));
  return c * (target / max(y, 1e-7));
}
// Light twins: the floor is the mirror image, measured down from white.
vec3 floorLuminance(vec3 c, float floorY) {
  float y = luma(c);
  float lifted = 1.0 - (1.0 - floorY) * (1.0 - exp(-(1.0 - y) / (1.0 - floorY)));
  return c * (max(lifted, 0.0) / max(y, 1e-7));
}
vec3 viewRay() {
  vec4 far = u_invMvp * vec4(v_ndc, 1.0, 1.0);
  return normalize(far.xyz / far.w - u_eye);
}
// 0 at the centre of the presented area, 1 at its corners.
float vignetteRadius() {
  vec2 q = vec2(
    (v_ndc.x - u_glowCenterX) / max(1.0 - u_glowCenterX, 1e-3),
    v_ndc.y
  );
  return clamp(length(q) / 1.41421, 0.0, 1.5);
}
// The planar far layer: the sky seen through a virtual camera that turns
// slowly as the pane pans (yaw with x, a bounded pitch with y) and widens a
// little with zoom, so a pan is seamless forever.
vec3 virtualSkyRay(float pitchBias) {
  float aspect = u_viewport.x / max(u_viewport.y, 1.0);
  float zoom = clamp(pow(max(u_eye.z - u_stageCenter.z, 0.05) / 3.0, 0.12), 0.7, 1.4);
  float tanHalf = 0.42 * zoom;
  vec3 r = normalize(vec3(v_ndc.x * aspect * tanHalf, v_ndc.y * tanHalf, -1.0));
  float yaw = (u_eye.x - u_stageCenter.x) / 9.0;
  float pitch = pitchBias + 0.45 * tanh((u_eye.y - u_stageCenter.y) / 12.0);
  float cp = cos(pitch), sp = sin(pitch);
  // Pitch up: the forward axis (-z) turns toward +y.
  r = vec3(r.x, cp * r.y - sp * r.z, sp * r.y + cp * r.z);
  float cy = cos(yaw), sy = sin(yaw);
  return vec3(cy * r.x + sy * r.z, r.y, -sy * r.x + cy * r.z);
}
// Where the view ray meets the plane z = (back of the data) - depth.
vec2 planarLayer(vec3 ray, float depth) {
  float z = u_stageCenter.z - u_stageExtent.z - depth;
  float rz = abs(ray.z) < 1e-5 ? -1e-5 : ray.z;
  float t = max((z - u_eye.z) / rz, 0.0);
  return (u_eye + ray * t).xy;
}
// A horizon dip: the sky's horizon sits below the eye, as it does from
// altitude, so a camera looking down on the data still sees sky.
vec3 dipped(vec3 d, float k) {
  return normalize(d + vec3(0.0, k, 0.0));
}
// How far a view ray passes from the data, in units of the data's size:
// below 1 the ray crosses the cloud.
float stageMiss(vec3 ray) {
  vec3 toStage = u_stageCenter - u_eye;
  float along = max(dot(toStage, ray), 0.0);
  return length(toStage - ray * along) / (length(u_stageExtent) * 1.05 + 0.15);
}
// Two-hash triangular dither of about one code value.
vec3 dither(vec3 srgb, float amount) {
  float a = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float b = hash12(gl_FragCoord.xy + 71.3);
  return srgb + (a + b - 1.0) * amount / 255.0;
}
vec4 finish(vec3 linear, float grain) {
  vec3 srgb = toSrgb(linear);
  srgb = mix(u_surface, srgb, u_opacity);
  return vec4(dither(srgb, grain), 1.0);
}
// Crisp star cores of one cell layer around a direction, round on screen,
// never narrower than one device pixel.
vec3 starCores(vec3 d, float cells, float probability, float seed, float gain, float pixelAngle, float twinkle) {
  vec2 uv;
  int face = cubeFaceOf(d, uv);
  vec2 cell = floor((uv * 0.5 + 0.5) * cells);
  vec3 sd;
  vec3 star = starInCell(face, cell, cells, probability, seed, sd);
  if (star.x < 0.5) return vec3(0.0);
  float ang = length(sd - d);
  float m = pow(star.y, 3.0);
  float sigma = max(pixelAngle * 0.62, pixelAngle * u_pixelRatio * (0.38 + 0.55 * m));
  float core = exp(-0.5 * ang * ang / (sigma * sigma));
  float flicker = 1.0 + twinkle * 0.45 * sin(u_time * (1.1 + 2.3 * star.z) + 40.0 * star.y);
  return starTint(star.z) * core * (0.08 + m) * gain * flicker;
}
`,rs=`${Mo}
uniform samplerCube u_sky;
uniform sampler2D u_tile;

const vec3 BAND_NORMAL = vec3(0.3283, 0.8536, -0.4048);
const vec3 DEEP = vec3(0.0011, 0.0013, 0.0034);
const vec3 BAND_LIFT = vec3(0.0042, 0.0040, 0.0062);

// Data tints graded toward the classic emission palette (H-alpha rose,
// O-III teal), so a field of warm colours never turns the sky to mud.
vec3 grade(vec3 tint, vec3 cosmic) {
  vec3 t = mix(tint, cosmic, 0.5);
  return t / max(luma(t), 1e-3);
}

// detail: fine fBm evaluated per fragment, finer than the cube's texels, so
// the clouds stay crisp at 4K and DPR 2 (-1..1, faded out where it would alias).
vec3 nebulaColour(vec4 s, float band, float detail) {
  float a = s.r * (1.0 + 0.45 * detail);
  float b = s.g * 2.0 * (1.0 + 0.6 * detail);
  float dust = clamp(s.b * (1.0 - 0.35 * detail), 0.0, 1.0);
  vec3 t0 = grade(u_tint0, vec3(1.0, 0.32, 0.45) / 0.49);
  vec3 t1 = grade(u_tint1, vec3(0.25, 0.75, 1.0) / 0.66);
  vec3 t2 = grade(u_tint2, vec3(0.75, 0.55, 1.0) / 0.62);
  vec3 col = DEEP + BAND_LIFT * band * (1.0 - 0.8 * dust);
  vec3 emission = t0 * (a * 0.012 + a * a * 0.060)
    + t1 * (b * 0.010 + b * b * 0.042)
    + t2 * a * b * 0.034
    + vec3(1.0, 0.95, 0.92) * pow(a * b, 2.0) * 0.050;
  emission *= 1.0 - 0.92 * dust;
  col *= 1.0 - 0.6 * dust;
  col += emission;
  return kneeLuminance(col, 0.042);
}

// Fine filament structure below the cube's resolution: two octaves of
// gradient noise on the sphere, faded out where a pixel spans an octave.
float nebulaDetail(vec3 d, float pixelAngle) {
  vec2 per = vec2(1e4);
  float n = gnoise(d * 22.0 + vec3(3.1, 1.7, 5.3), per) * 0.65
    + gnoise(d * 47.0 + vec3(9.2, 4.4, 0.6), per) * 0.35 * (1.0 - smoothstep(0.004, 0.012, pixelAngle));
  return n * (1.0 - smoothstep(0.012, 0.04, pixelAngle));
}

vec3 nebulaStars(vec3 d, float band, float pixelAngle, float twinkle) {
  return starCores(d, 40.0, 0.05 + 0.16 * band, 3.0, 1.0, pixelAngle, twinkle)
    + starCores(d, 130.0, 0.05 + 0.12 * band, 11.0, 0.22, pixelAngle, twinkle)
    + starCores(d, 360.0, 0.03 + 0.20 * band, 23.0, 0.05, pixelAngle * 1.4, 0.0);
}

void main() {
  vec3 ray = viewRay();
  float twinkle = u_ambient;
  // Stars dim behind the data cloud, so no star can pass for a cell.
  float behind = mix(0.35, 1.0, smoothstep(0.55, 1.5, stageMiss(ray)));
  vec3 col;
  if (u_planar < 0.5) {
    float pixelAngle = max(length(fwidth(ray)), 1e-6);
    vec3 d = ray;
    vec4 s = texture(u_sky, d);
    float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
    col = nebulaColour(s, band, nebulaDetail(d, pixelAngle));
    // Near layer: a dust shell around the stage, which slides against the
    // sky as the camera moves.
    vec3 oc = u_eye - u_stageCenter;
    float radius = max(7.5, length(u_stageExtent) * 3.0);
    float bq = dot(oc, ray);
    float cq = dot(oc, oc) - radius * radius;
    float disc = bq * bq - cq;
    if (disc > 0.0) {
      float t = -bq + sqrt(disc);
      vec3 shell = normalize(oc + ray * t);
      vec4 near = texture(u_sky, vec3(shell.z, shell.x, -shell.y));
      float wisp = smoothstep(0.3, 0.9, near.b) * (0.4 + 0.6 * near.r);
      col *= 1.0 - 0.45 * wisp;
    }
    float glow = s.a / max(1.0 - s.a, 1e-3);
    col += kneeLuminance(vec3(0.85, 0.90, 1.0) * glow * 0.020, 0.045) * behind;
    col += nebulaStars(d, band, pixelAngle, twinkle) * behind;
  } else {
    // Far: the sky through the virtual camera. Near: wisps and stars on a
    // plane behind the data, with true parallax.
    vec3 d = virtualSkyRay(0.0);
    float skyPixel = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
    col = nebulaColour(s, band, nebulaDetail(d, skyPixel));
    float glow = s.a / max(1.0 - s.a, 1e-3);
    col += kneeLuminance(vec3(0.85, 0.90, 1.0) * glow * 0.020, 0.045) * behind;
    col += (starCores(d, 40.0, 0.05 + 0.16 * band, 3.0, 1.0, skyPixel, twinkle)
      + starCores(d, 130.0, 0.05 + 0.12 * band, 11.0, 0.22, skyPixel, twinkle)) * behind;
    vec2 nearUv = planarLayer(ray, 2.6) / 7.0;
    vec4 tile = texture(u_tile, nearUv);
    float wisp = smoothstep(0.3, 0.95, tile.b);
    col *= 1.0 - 0.40 * wisp;
    col += grade(u_tint0, vec3(1.0, 0.32, 0.45) / 0.49) * 0.0035 * smoothstep(0.4, 1.0, tile.r) * (1.0 - wisp);
    // Near stars on the same plane: cells in plane units.
    vec2 p = planarLayer(ray, 2.6) * 6.0;
    float px = max(length(fwidth(p)), 1e-6);
    vec2 cell = floor(p);
    float h = hash12(cell + 7.0);
    if (h < 0.05) {
      vec2 centre = cell + 0.25 + 0.5 * hash22(cell + 3.0);
      float m = pow(hash12(cell + 13.0), 3.0);
      float sigma = max(px * 0.62, px * u_pixelRatio * (0.4 + 0.5 * m));
      float dist = length(p - centre);
      float flicker = 1.0 + twinkle * 0.45 * sin(u_time * (1.3 + 24.0 * h) + 9.0 * m);
      col += starTint(hash12(cell + 29.0)) * exp(-0.5 * dist * dist / (sigma * sigma)) * (0.06 + 0.6 * m) * flicker * behind;
    }
  }
  // Vignette: the frame falls off toward its corners.
  float v = vignetteRadius();
  col *= 1.0 - 0.55 * smoothstep(0.35, 1.15, v);
  fragColor = finish(col, 1.0);
}
`,ns=`${Mo}
uniform sampler2D u_shadow;    // r: cast shadow, g: ambient occlusion, 0..1
uniform vec3 u_shadowWindow;   // centre u, centre v, half size
uniform float u_shadowReady;
uniform vec3 u_keyLight;       // toward the key light, unit
uniform float u_paperGap;

const vec3 PAPER = vec3(0.880, 0.858, 0.822);   // warm paper
const vec3 KEY = vec3(1.0, 0.962, 0.900);
const vec3 FILL = vec3(0.925, 0.950, 1.0);

vec2 shadowAt(vec2 uv) {
  vec2 st = (uv - u_shadowWindow.xy) / (2.0 * u_shadowWindow.z) + 0.5;
  float inside = smoothstep(0.0, 0.04, st.x) * smoothstep(0.0, 0.04, st.y)
    * smoothstep(1.0, 0.96, st.x) * smoothstep(1.0, 0.96, st.y);
  return texture(u_shadow, st).rg * inside * u_shadowReady;
}

// Paper tooth anchored to the surface: fades out before it can alias.
float paperGrain(vec2 uv) {
  vec2 p = uv * 190.0;
  float footprint = length(fwidth(p));
  float fibres = gnoise(vec3(p * vec2(1.0, 0.35), 0.5), vec2(1e4)) * 0.6
    + gnoise(vec3(p * 2.3, 2.5), vec2(1e4)) * 0.4;
  return fibres * (1.0 - smoothstep(0.35, 0.9, footprint));
}

// A shadowed patch of paper: darker, and cooler (lit by the fill only).
vec3 applyShadow(vec3 c, vec2 s) {
  float occlusion = clamp(0.30 * s.r + 0.20 * s.g, 0.0, 0.42);
  vec3 shaded = c * mix(vec3(1.0), vec3(0.97, 0.985, 1.0), smoothstep(0.0, 0.3, occlusion));
  return shaded * (1.0 - occlusion);
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  float reach = max(max(u_stageExtent.x, u_stageExtent.z), 0.6) * 2.4;
  if (u_planar < 0.5) {
    // An infinite cyclorama: the floor sweeps up into the wall at the
    // horizon with no edge; both meet the same horizon colour.
    float height = u_eye.y - u_floorY;
    float rise = clamp(ray.y, -1.0, 1.0);
    vec2 keyDir = normalize(u_keyLight.xz + 1e-5);
    vec2 heading = normalize(ray.xz + 1e-5);
    float keySide = 0.5 + 0.5 * dot(heading, keyDir);
    vec3 horizon = PAPER * mix(FILL, KEY, keySide) * 0.90;
    // The wall: a soft key-lit sweep, brightest low on the key side, falling
    // off upward (and, seen from below the floor, downward) into a cool top.
    float sweep = exp(-pow((abs(rise) - 0.12) / 0.45, 2.0));
    float keyLobe = pow(max(dot(heading, keyDir), 0.0), 3.0);
    vec3 wall = horizon * (0.93 + 0.07 * sweep + 0.07 * keyLobe * sweep)
      * mix(vec3(1.0), FILL * 0.86, smoothstep(0.1, 1.0, abs(rise)));
    col = wall;
    // The floor point, and its grain, in uniform control flow so the
    // grain's derivatives are defined.
    float t = min(abs(height) / max(abs(rise), 1e-4), 1e4);
    vec2 uv = (u_eye + ray * t).xz;
    float grain = paperGrain(uv);
    if (rise < 0.0 && height > 0.0) {
      // A key pool on the floor, off-centre toward the light, falling away
      // to the horizon tone; the side away from the key is cooler.
      vec2 poolCentre = u_stageCenter.xz + u_keyLight.xz * reach * 0.35;
      vec2 offset = uv - poolCentre;
      float pool = exp(-dot(offset, offset) / (reach * reach));
      float wide = exp(-dot(offset, offset) / (reach * reach * 9.0));
      float side = dot(normalize(offset + 1e-5), keyDir) * smoothstep(0.0, reach, length(offset));
      vec3 lightColour = mix(FILL, KEY, 0.55 + 0.45 * side);
      vec3 floorColour = PAPER * lightColour * (0.86 + 0.08 * wide + 0.12 * pool);
      floorColour = applyShadow(floorColour, shadowAt(uv));
      floorColour *= 1.0 + 0.010 * grain;
      // The cove: the floor blends into the horizon colour as it nears
      // grazing, so floor and wall meet without an edge.
      float cove = 1.0 - smoothstep(0.0, 0.30, -rise);
      col = mix(floorColour, horizon, cove);
    } else if (rise > 0.0 && height < 0.0) {
      // Below the stage, looking up: the floor is a sheet of paper lit from
      // above, glowing through, with the data's shadow showing through it as
      // a soft, cool silhouette.
      vec2 offset = uv - (u_stageCenter.xz + u_keyLight.xz * reach * 0.35);
      float glowPool = exp(-dot(offset, offset) / (reach * reach * 2.2));
      vec3 backlit = PAPER * mix(vec3(1.0), KEY, 0.6) * (0.93 + 0.11 * glowPool);
      vec2 s = shadowAt(uv);
      float through = clamp(0.24 * s.r + 0.12 * s.g, 0.0, 0.32);
      backlit = mix(backlit, backlit * FILL * 0.92, smoothstep(0.0, 0.25, through));
      backlit *= 1.0 - through;
      backlit *= 1.0 + 0.012 * grain;
      float cove = 1.0 - smoothstep(0.0, 0.30, rise);
      col = mix(backlit, horizon, cove);
    }
  } else {
    // Paper behind the data with true parallax; the data hovers above it.
    vec2 uv = planarLayer(ray, u_paperGap);
    float grain = paperGrain(uv * 0.8);
    float extent = max(max(u_stageExtent.x, u_stageExtent.y), 0.6);
    vec2 centre = u_stageCenter.xy + vec2(-0.30, 0.38) * extent;
    vec2 offset = (uv - centre) / extent;
    float pool = exp(-dot(offset, offset) / 2.2);
    float wide = exp(-dot(offset, offset) / 14.0);
    vec2 keyDir = normalize(vec2(-0.45, 0.55));
    float side = dot(normalize(offset + 1e-5), keyDir) * smoothstep(0.0, 2.0, length(offset));
    col = PAPER * mix(FILL, KEY, 0.55 + 0.45 * side) * (0.86 + 0.08 * wide + 0.11 * pool);
    col = applyShadow(col, shadowAt(uv));
    col *= 1.0 + 0.012 * grain;
  }
  float v = vignetteRadius();
  col *= 1.0 - 0.07 * smoothstep(0.3, 1.2, v);
  col = floorLuminance(col, 0.62);
  // Fine paper grain over the whole frame doubles as the anti-banding dither.
  fragColor = finish(col, 1.6);
}
`,as=`${Mo}
uniform samplerCube u_sky;     // r: broad shafts, g: caustics, b: murk, a: fine shafts
uniform sampler2D u_tile;      // r: murk, g: caustics (periodic)

const vec3 SUN = vec3(0.2357, 0.9428, 0.2357);
const float DIP = 0.55;

vec3 water(vec3 d, vec4 s, float planarMurk) {
  float rise = d.y;
  vec3 top, horizon, depth, shaftColour, causticColour;
  if (u_dark > 0.5) {
    top = vec3(0.012, 0.050, 0.068);
    horizon = vec3(0.0035, 0.0160, 0.0250);
    depth = vec3(0.0005, 0.0018, 0.0036);
    shaftColour = vec3(0.020, 0.080, 0.085);
    causticColour = vec3(0.012, 0.050, 0.050);
  } else {
    top = vec3(0.90, 0.98, 0.96);
    horizon = vec3(0.56, 0.81, 0.83);
    depth = vec3(0.40, 0.69, 0.74);
    shaftColour = vec3(0.36, 0.28, 0.18);
    causticColour = vec3(0.20, 0.17, 0.12);
  }
  vec3 col = rise > 0.0
    ? mix(horizon, top, pow(smoothstep(0.0, 1.0, rise), 0.7))
    : mix(horizon, depth, smoothstep(0.0, 0.75, -rise));
  float murk = mix(s.b, planarMurk, u_planar);
  col *= 0.84 + 0.32 * murk;
  float shafts = s.r * 0.85 + s.a * 0.6;
  shafts *= smoothstep(-0.55, 0.15, rise);
  float sunAngle = acos(clamp(dot(d, SUN), -1.0, 1.0));
  float sunGlow = exp(-sunAngle * sunAngle / 0.20);
  if (u_dark > 0.5) {
    col += shaftColour * shafts;
    col += causticColour * s.g;
    col += shaftColour * 0.7 * sunGlow;
    col = kneeLuminance(col, 0.046);
  } else {
    col += shaftColour * shafts * 0.40;
    col += causticColour * s.g * 0.8;
    // The sunlit surface overhead, rippled: darker troughs between the
    // bright caustic crests.
    col = mix(col, col * vec3(0.84, 0.93, 0.96), (1.0 - s.g) * smoothstep(0.25, 0.8, rise) * 0.55);
    col += vec3(0.14, 0.10, 0.05) * sunGlow;
    col = floorLuminance(col, 0.62);
  }
  return col;
}

// Sunlit shallows only: a sandy floor below the stage under a caustic web,
// sliding with true parallax and fading into turquoise water.
vec3 sandFloor(vec2 uv, float distance, vec3 waterColour) {
  // Two baked web layers (tile .g and .b) drifting against each other.
  float drift = u_time * 0.02;
  float caustic = texture(u_tile, uv * 1.3 / 8.0 + vec2(drift, 0.3 * drift)).g * 0.65
    + texture(u_tile, uv * 2.3 / 5.0 + vec2(0.37 - 0.7 * drift, drift)).b * 0.35;
  float ripple = texture(u_tile, uv / 6.0).r;
  vec3 sand = vec3(0.94, 0.86, 0.70) * (0.92 + 0.10 * ripple);
  vec3 lit = sand + vec3(0.18, 0.18, 0.14) * pow(caustic, 1.5);
  // Shallow water over the sand: a light turquoise cast, deepening with distance.
  lit *= vec3(0.90, 0.98, 0.97);
  float fog = 1.0 - exp(-distance / 11.0);
  return mix(lit, waterColour, clamp(fog, 0.0, 1.0));
}

vec3 seaFloor(vec3 ray, vec3 waterColour) {
  // The sand lies under the stage, and sinks under a camera that dives
  // below the data, so there is always a sea floor beneath the viewer.
  float floorY = min(u_floorY - 1.2, u_eye.y - 1.2);
  if (u_dark > 0.5 || ray.y >= -0.01) return waterColour;
  float t = (floorY - u_eye.y) / ray.y;
  vec2 uv = (u_eye + ray * t).xz;
  return sandFloor(uv, t, waterColour);
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  vec3 tint = u_tint0 * 0.6 + u_tint1 * 0.4;
  tint /= max(luma(tint), 1e-3);
  if (u_planar < 0.5) {
    vec3 d = dipped(ray, DIP);
    vec4 s = texture(u_sky, d);
    col = water(d, s, 0.5);
    col = seaFloor(ray, col);
  } else {
    // Looking up toward the surface, where the rays converge.
    vec3 d = virtualSkyRay(0.85);
    vec4 s = texture(u_sky, d);
    vec2 near = planarLayer(ray, 3.5) / 9.0;
    vec4 tile = texture(u_tile, near);
    col = water(d, s, tile.r);
    if (u_dark > 0.5) {
      float ca = texture(u_tile, planarLayer(ray, 1.2) / 3.0).b;
      float fromTop = smoothstep(-1.2, 1.0, v_ndc.y);
      col += vec3(0.004, 0.018, 0.018) * ca * fromTop;
    } else {
      // Looking straight down into the shallows: sand under the data.
      vec2 sand = planarLayer(ray, 1.4);
      float depth = max(u_eye.z - (u_stageCenter.z - u_stageExtent.z - 1.4), 0.5);
      col = sandFloor(sand, depth * 0.6, col);
    }
  }
  // A faint bioluminescent haze behind the data, in the data's own hues.
  float miss = stageMiss(ray);
  float haze = exp(-miss * miss * 1.4);
  if (u_dark > 0.5) {
    col += mix(vec3(0.010, 0.040, 0.042), tint * 0.022, 0.5) * haze * 0.6;
  } else {
    col = mix(col, col * mix(vec3(1.0), tint, 0.08), haze * 0.7);
  }
  float v = vignetteRadius();
  col *= 1.0 - (u_dark > 0.5 ? 0.6 : 0.08) * smoothstep(0.3, 1.2, v);
  fragColor = finish(col, u_dark > 0.5 ? 1.0 : 1.4);
}
`,is=`${Mo}
uniform samplerCube u_sky;    // r: cloud opacity, g: cloud lit, b: curtain, a: curtain height
uniform sampler2D u_tile;     // r: cloud density, g: top-lit, b: second layer

const vec3 SUN = vec3(0.7894, 0.1105, -0.6039);
const float DIP = 0.55;

vec3 sky(vec3 d, vec4 s, float pixelAngle, float behind) {
  float rise = d.y;
  float sunAngle = acos(clamp(dot(d, SUN), -1.0, 1.0));
  vec3 col;
  if (u_dark > 0.5) {
    vec3 zenith = vec3(0.0010, 0.0017, 0.0050);
    vec3 horizon = vec3(0.0055, 0.0085, 0.0165);
    col = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, abs(rise)), 0.6));
    // Moon haze where the sun would be.
    col += vec3(0.010, 0.013, 0.020) * exp(-sunAngle / 0.35);
    // Stars, hidden behind clouds and fading into the horizon haze.
    float starVis = (1.0 - 0.6 * s.r) * smoothstep(0.02, 0.25, rise) * behind;
    col += starCores(d, 120.0, 0.14, 41.0, 0.22, pixelAngle, u_ambient) * starVis;
    col += starCores(d, 44.0, 0.10, 7.0, 0.85, pixelAngle, u_ambient) * starVis;
    // The curtains: green at the foot, violet into the top; the data's
    // hue nudges the green.
    vec3 green = mix(vec3(0.020, 0.115, 0.060), u_tint0 * 0.08, 0.2);
    vec3 violet = mix(vec3(0.055, 0.018, 0.090), u_tint1 * 0.06, 0.2);
    vec3 aurora = mix(green, violet, smoothstep(0.12, 0.55, s.a)) * s.b * 1.8;
    // Airglow: a faint green band along the horizon under the curtains.
    col += vec3(0.002, 0.007, 0.004) * exp(-abs(rise) / 0.08);
    // Night clouds are thin veils: the curtains show through them.
    float veil = s.r * 0.6;
    col += aurora * (1.0 - 0.6 * veil);
    // Night clouds: dark, rimmed by aurora light.
    vec3 cloud = vec3(0.0028, 0.0038, 0.0068) + green * 0.22 * s.g;
    col = mix(col, cloud, veil * 0.85);
    col = kneeLuminance(col, 0.046);
  } else {
    vec3 zenith = vec3(0.50, 0.65, 0.92);
    vec3 horizon = vec3(1.0, 0.82, 0.66);
    col = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, max(rise, 0.0)), 0.5));
    // A rose band just above the horizon, as at dawn.
    col += vec3(0.10, 0.015, 0.06) * exp(-pow((rise - 0.10) / 0.09, 2.0));
    // Sun haze: a wide warm bloom and a soft core.
    col += vec3(0.30, 0.15, 0.03) * exp(-sunAngle / 0.38);
    col += vec3(0.30, 0.24, 0.14) * exp(-sunAngle * sunAngle / 0.004);
    // Clouds lit pink-gold on the sun side, lavender in their shade.
    float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-5), normalize(SUN.xz));
    vec3 litColour = mix(vec3(1.0, 0.96, 0.97), vec3(1.0, 0.85, 0.70), sunSide * sunSide);
    vec3 shadeColour = vec3(0.62, 0.62, 0.80);
    vec3 cloud = mix(shadeColour, litColour, smoothstep(0.15, 0.85, s.g));
    col = mix(col, cloud, clamp(s.r * 1.25, 0.0, 0.95));
    col = floorLuminance(col, 0.62);
  }
  return col;
}

// The sea of clouds below the horizon: two world-anchored tiles on planes
// under the stage, so it slides with parallax; it melts into the haze.
vec3 cloudSea(vec3 d, vec3 haze) {
  // Under the stage, and always under the camera: seen from below the data
  // the sea of clouds stays below the horizon.
  float seaY = min(u_floorY - 2.5, u_eye.y - 2.0);
  float drop = max(u_eye.y - seaY, 0.5);
  float t = drop / max(-d.y, 1e-3);
  vec2 uv = u_eye.xz + d.xz * t;
  vec4 a = texture(u_tile, uv / 14.0);
  vec4 b = texture(u_tile, uv / 5.5 + 0.31);
  float dens = smoothstep(0.18, 0.70, a.r * 0.75 + b.b * 0.35);
  float lit = mix(a.g, b.g, 0.35);
  float fog = 1.0 - exp(-t / 26.0);
  vec3 col;
  if (u_dark > 0.5) {
    vec3 gap = vec3(0.0016, 0.0024, 0.0052);
    vec3 top = vec3(0.0050, 0.0085, 0.0125) + vec3(0.003, 0.020, 0.011) * lit;
    col = mix(gap, top, dens);
  } else {
    vec3 gap = vec3(0.64, 0.68, 0.84);
    float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-5), normalize(SUN.xz));
    vec3 top = mix(vec3(0.76, 0.75, 0.86), mix(vec3(1.0, 0.96, 0.94), vec3(1.0, 0.88, 0.76), sunSide), smoothstep(0.2, 0.8, lit));
    col = mix(gap, top, dens);
  }
  return mix(col, haze, clamp(fog, 0.0, 1.0));
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  float behind = mix(0.35, 1.0, smoothstep(0.55, 1.5, stageMiss(ray)));
  if (u_planar < 0.5) {
    vec3 d = dipped(ray, DIP);
    float pixelAngle = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    vec3 skyColour = sky(d, s, pixelAngle, behind);
    if (d.y >= 0.0) {
      col = skyColour;
    } else {
      vec3 horizonDir = normalize(vec3(d.x, 0.004, d.z));
      vec3 haze = sky(horizonDir, texture(u_sky, horizonDir), pixelAngle, 0.0);
      col = cloudSea(d, haze);
    }
  } else {
    vec3 d = virtualSkyRay(0.30);
    float pixelAngle = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    col = sky(d, s, pixelAngle, behind);
    // A drifting cloud layer on a plane behind the data.
    vec2 near = planarLayer(ray, 3.2) / 8.0;
    vec4 tile = texture(u_tile, near);
    float dens = smoothstep(0.42, 0.95, tile.r) * smoothstep(-1.1, 0.4, v_ndc.y);
    vec3 cloud = u_dark > 0.5
      ? vec3(0.0035, 0.0050, 0.0085) + vec3(0.002, 0.014, 0.008) * tile.g
      : mix(vec3(0.78, 0.77, 0.85), vec3(1.0, 0.94, 0.89), tile.g);
    col = mix(col, cloud, dens * 0.55);
  }
  float v = vignetteRadius();
  col *= 1.0 - (u_dark > 0.5 ? 0.5 : 0.07) * smoothstep(0.3, 1.2, v);
  fragColor = finish(col, u_dark > 0.5 ? 1.0 : 1.4);
}
`,ss=`#version 300 es
precision highp float;
layout(location = 0) in vec4 a_seed;   // xyz: -1..1, w: 0..1 (population, size)
uniform mat4 u_mvp;
uniform vec3 u_eye;
uniform vec3 u_stageCenter;
uniform vec3 u_stageExtent;
uniform float u_projScale;     // projection[5]
uniform float u_viewportHeight;
uniform float u_pixelRatio;
uniform float u_time;
uniform float u_planar;
uniform float u_maxPointSize;
uniform vec4 u_ndcTransform;   // pane NDC = raster NDC * xy + zw (see COMMON_VS)
out float v_glow;
out float v_alpha;
out float v_hue;
out float v_blur;
void main() {
  vec3 ext = max(u_stageExtent, vec3(0.25));
  vec3 pos;
  float attendant = step(a_seed.w, 0.28);
  float drift = u_time * (0.010 + 0.012 * fract(a_seed.w * 7.0));
  float boxFade = 1.0;
  if (attendant > 0.5) {
    // Attendants: a loose shell hugging the data cloud.
    vec3 dir = normalize(a_seed.xyz + 1e-4);
    float r = 0.9 + 0.9 * fract(a_seed.w * 13.7);
    pos = u_stageCenter + dir * ext * r * 1.2;
    pos.y -= mod(drift, 0.6) - 0.3;
  } else {
    // Ambient: a box that wraps around the camera, so the snow never ends.
    float box = 12.0;
    vec3 p = a_seed.xyz * box * 0.5;
    p.y -= drift * 3.0;
    vec3 rel = mod(p - u_eye + box * 0.5, box) - box * 0.5;
    pos = u_eye + rel;
    boxFade = 1.0 - smoothstep(0.30, 0.5, max(max(abs(rel.x), abs(rel.y)), abs(rel.z)) / box);
  }
  if (u_planar > 0.5) {
    // Keep planar snow behind the data plane.
    float back = u_stageCenter.z - u_stageExtent.z - 0.15;
    pos.z = min(pos.z, back - 0.05 - 3.0 * fract(a_seed.w * 31.3));
  }
  vec4 clip = u_mvp * vec4(pos, 1.0);
  float worldSize = 0.006 + 0.012 * fract(a_seed.w * 53.1);
  float size = worldSize * u_projScale * u_viewportHeight * 0.5 / max(clip.w, 1e-3);
  float minimum = 1.0 * u_pixelRatio;
  float device = max(size, minimum);
  // Near motes turn into soft bokeh: bigger, blurrier, fainter.
  float blur = smoothstep(1.6, 0.3, clip.w);
  float bokeh = device * (1.0 + 5.0 * blur);
  float drawn = min(bokeh * 2.6, u_maxPointSize);
  gl_PointSize = drawn;
  // Into the target's own clip space (identity on screen).
  gl_Position = vec4((clip.xy - u_ndcTransform.zw * clip.w) / u_ndcTransform.xy, clip.zw);
  // Energy kept roughly constant as a mote grows; dimmed when below 1 px.
  float coverage = clamp(size / minimum, 0.2, 1.0) * (device * device) / (bokeh * bokeh);
  vec3 rel = (pos - u_stageCenter) / (ext * 1.1 + 0.15);
  float spread = length(rel);
  v_glow = exp(-max(spread - 0.8, 0.0) * 2.2);
  float tooNear = smoothstep(0.12, 0.45, clip.w);
  v_alpha = coverage * tooNear * boxFade * (clip.w > 0.0 ? 1.0 : 0.0);
  v_hue = fract(a_seed.w * 97.3);
  v_blur = blur;
}
`,cs=`#version 300 es
precision highp float;
in float v_glow;
in float v_alpha;
in float v_hue;
in float v_blur;
uniform float u_dark;
uniform float u_opacity;
uniform vec3 u_tint0;
uniform vec3 u_tint1;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c) * 6.76;     // sprite is 2.6x the mote
  float sharpness = mix(2.2, 0.55, v_blur);
  float core = exp(-r2 * sharpness);
  float halo = exp(-r2 * 0.35) * 0.25;
  vec3 tint = mix(u_tint0, u_tint1, step(0.5, v_hue));
  tint /= max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  if (u_dark > 0.5) {
    // Additive light: faint cyan snow that blooms in the data's hues
    // near the cloud.
    vec3 snow = vec3(0.09, 0.20, 0.22);
    vec3 bloom = mix(vec3(0.15, 0.85, 0.85), tint * 0.5, 0.55);
    vec3 col = snow * core * 0.32 + bloom * (core + halo) * v_glow * 0.22;
    fragColor = vec4(sqrt(col) * 0.55 * v_alpha * u_opacity, 1.0);
  } else {
    // Sunlit specks: soft and slightly darker; near the data they catch its hue.
    vec3 speck = mix(vec3(0.42, 0.56, 0.57), sqrt(tint * 0.25), v_glow * 0.6);
    float a = (core * 0.22 + halo * 0.10 * v_glow) * v_alpha * u_opacity;
    fragColor = vec4(speck * a, a);
  }
}
`,ia=Object.freeze({"bake:nebula":Object.freeze({vs:At,fs:es}),"bake:abyss":Object.freeze({vs:At,fs:ts}),"bake:aurora":Object.freeze({vs:At,fs:os}),"draw:nebula":Object.freeze({vs:At,fs:rs}),"draw:atelier":Object.freeze({vs:At,fs:ns}),"draw:abyss":Object.freeze({vs:At,fs:as}),"draw:aurora":Object.freeze({vs:At,fs:is}),"draw:motes":Object.freeze({vs:ss,fs:cs})});var yr=9,To=10,zt=11,fs=Object.freeze([1,1,0,0]),us=8,gr=Symbol("wait"),ca=131072,ds=1024,hs=128,ps=16,ms=2e3,gt=512,wr=3200,la=Object.freeze({nebula:{bake:"bake:nebula",draw:"draw:nebula",cube:"byte",tile:!0},atelier:{bake:null,draw:"draw:atelier",cube:null,tile:!1},abyss:{bake:"bake:abyss",draw:"draw:abyss",cube:"byte",tile:!0,motes:!0},aurora:{bake:"bake:aurora",draw:"draw:aurora",cube:"byte",tile:!0}});function So(e){let o=So.f32??=new Float32Array(1),t=So.u32??=new Uint32Array(o.buffer);o[0]=e;let r=t[0],n=r>>>16&32768,i=(r>>>23&255)-127+15,c=r&8388607;if(i<=0)return i<-10?n:(c=(c|8388608)>>1-i,n|c+4096>>13);if(i>=31)return n|31744;let s=c+4096;return s&8388608?(i+=1,i>=31?n|31744:n|i<<10):n|i<<10|s>>13}a(So,"halfFromFloat");var fa=64;function*vr(e,o,t,r,n){if(t<1)return;let i=t*2+1;for(let c=0;c<r;c++){for(let s=0;s<o;s++){let l=s*o,h=0;for(let d=-t;d<=t;d++)h+=e[l+Math.min(o-1,Math.max(0,d))];for(let d=0;d<o;d++){n[l+d]=h/i;let u=Math.min(o-1,d+t+1),m=Math.max(0,d-t);h+=e[l+u]-e[l+m]}(s+1)%fa===0&&(yield)}for(let s=0;s<o;s++){let l=0;for(let h=-t;h<=t;h++)l+=n[Math.min(o-1,Math.max(0,h))*o+s];for(let h=0;h<o;h++){e[h*o+s]=l/i;let d=Math.min(o-1,h+t+1),u=Math.max(0,h-t);l+=n[d*o+s]-n[u*o+s]}(s+1)%fa===0&&(yield)}}}a(vr,"boxBlur");function bs(e){if(!(e instanceof Uint8Array))return 0;let o=new Uint32Array(e.buffer,e.byteOffset,e.byteLength>>>2),t=2166136261^e.length;for(let r=0;r<o.length;r++)t=Math.imul(t^o[r],16777619);for(let r=o.length*4;r<e.length;r++)t=Math.imul(t^e[r],16777619);return t>>>0}a(bs,"visibilitySignature");function ua(e,{invalidate:o,prefersReducedMotion:t,readViewSource:r}){let n=a(()=>performance.now(),"now"),i=e.getExtension("KHR_parallel_shader_compile"),c=Math.min(64,e.getParameter(e.ALIASED_POINT_SIZE_RANGE)[1]||64),s=!1,l=null,h=0,d=1,u=!1,m=null,A=0,y=0,b=0,T=new Map,_=new Map,g=new Map,w=[],C=[],E=null,L=null,z={slices:0,maxSliceMs:0,totalMs:0};function P(){E!==null||s||(typeof requestIdleCallback=="function"?(L="idle",E=requestIdleCallback(R,{timeout:120})):(L="timeout",E=setTimeout(R,4)))}a(P,"scheduleSlice");function F(){E!==null&&(L==="idle"?cancelIdleCallback(E):clearTimeout(E),E=null)}a(F,"cancelSlice");function R(){if(E=null,s||w.length===0)return;let f=n(),p=!1;for(;w.length>0;){let v=w[0],O=n(),N;try{N=v.iterator.next()}catch(ie){w.shift(),console.error(`[backdrop-looks] ${v.name} failed:`,ie);continue}let X=n()-O;if(v.cpuMs+=X,v.units+=1,X>v.maxUnitMs&&(v.maxUnitMs=X,v.maxUnitStage=v.stage),!N.done&&N.value===gr){p=!0;break}if(N.done&&(w.shift(),v.doneAt=n(),C.push({name:v.name,units:v.units,cpuMs:+v.cpuMs.toFixed(2),maxUnitMs:+v.maxUnitMs.toFixed(2),maxUnitStage:v.maxUnitStage,wallMs:+(v.doneAt-v.startedAt).toFixed(1)}),C.length>40&&C.shift()),n()-f>=us)break}let x=n()-f;z.slices+=1,z.totalMs+=x,z.maxSliceMs=Math.max(z.maxSliceMs,x),w.length>0&&(p?(L="timeout",E=setTimeout(R,1)):P())}a(R,"runSlice");function $(f,p,x=!1){let v={name:f,iterator:null,cpuMs:0,units:0,maxUnitMs:0,maxUnitStage:null,stage:"start",startedAt:n(),doneAt:null,cancelled:!1};return v.iterator=p(v),x?w.unshift(v):w.push(v),P(),v}a($,"enqueue");function D(f){if(f==null)return;f.cancelled=!0;let p=w.indexOf(f);p>=0&&w.splice(p,1)}a(D,"cancelJob");let B=e.createVertexArray(),I=e.createBuffer();e.bindVertexArray(B),e.bindBuffer(e.ARRAY_BUFFER,I),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null);let k=null,U=null;function V(){if(k!==null)return;let f=new Float32Array(wr*4),p=1234567,x=a(()=>(p=Math.imul(p^p>>>15,2246822507)^Math.imul(p^p>>>13,3266489909),p^=p>>>16,(p>>>0)/4294967296),"random");for(let v=0;v<wr;v++)f[v*4]=x()*2-1,f[v*4+1]=x()*2-1,f[v*4+2]=x()*2-1,f[v*4+3]=x();k=e.createVertexArray(),U=e.createBuffer(),e.bindVertexArray(k),e.bindBuffer(e.ARRAY_BUFFER,U),e.bufferData(e.ARRAY_BUFFER,f,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,4,e.FLOAT,!1,0,0),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null),b+=f.byteLength}a(V,"ensureMotes");let H=br(e);function ce(){return{framebuffer:e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),viewport:H.viewport,program:e.getParameter(e.CURRENT_PROGRAM),vao:e.getParameter(e.VERTEX_ARRAY_BINDING),blend:H.isEnabled(e.BLEND),depth:H.isEnabled(e.DEPTH_TEST),scissor:H.isEnabled(e.SCISSOR_TEST),scissorBox:H.scissorBox,cull:H.isEnabled(e.CULL_FACE),activeTexture:H.activeTexture}}a(ce,"saveState");function re(f){e.bindFramebuffer(e.DRAW_FRAMEBUFFER,f.framebuffer),e.viewport(f.viewport[0],f.viewport[1],f.viewport[2],f.viewport[3]),e.useProgram(f.program),e.bindVertexArray(f.vao),(f.blend?e.enable:e.disable).call(e,e.BLEND),(f.depth?e.enable:e.disable).call(e,e.DEPTH_TEST),(f.scissor?e.enable:e.disable).call(e,e.SCISSOR_TEST),e.scissor(f.scissorBox[0],f.scissorBox[1],f.scissorBox[2],f.scissorBox[3]),(f.cull?e.enable:e.disable).call(e,e.CULL_FACE),e.activeTexture(f.activeTexture)}a(re,"restoreState");function xe(f){let p=T.get(f);if(p)return p;let x=ia[f],v=e.createShader(e.VERTEX_SHADER);e.shaderSource(v,x.vs),e.compileShader(v);let O=e.createShader(e.FRAGMENT_SHADER);e.shaderSource(O,x.fs),e.compileShader(O);let N=e.createProgram();return e.attachShader(N,v),e.attachShader(N,O),e.bindAttribLocation(N,0,f==="draw:motes"?"a_seed":"a_corner"),e.linkProgram(N),p={key:f,program:N,vs:v,fs:O,ready:!1,failed:!1,uniforms:new Map,startedAt:n(),readyAt:0},T.set(f,p),p}a(xe,"startProgram");function Ce(f){if(f.ready||f.failed)return!0;if(i&&!e.getProgramParameter(f.program,i.COMPLETION_STATUS_KHR))return!1;if(!e.getProgramParameter(f.program,e.LINK_STATUS))return f.failed=!0,console.error(`[backdrop-looks] ${f.key} failed to link:`,e.getProgramInfoLog(f.program),e.getShaderInfoLog(f.vs),e.getShaderInfoLog(f.fs)),!0;let p=e.getProgramParameter(f.program,e.ACTIVE_UNIFORMS);for(let x=0;x<p;x++){let v=e.getActiveUniform(f.program,x),O=v.name.replace(/\[0\]$/,"");f.uniforms.set(O,e.getUniformLocation(f.program,v.name))}return f.ready=!0,f.readyAt=n(),!0}a(Ce,"pollProgram");function*ze(f){let p=f.map(xe);for(;!p.every(Ce);)yield gr;return p}a(ze,"awaitPrograms");function Ne(f,p){let x=e.createTexture();return e.activeTexture(e.TEXTURE0+p),e.bindTexture(f,x),x}a(Ne,"createTexture");function $e(f){let p=_.get(f);return p||(p={family:f,cube:null,cubeSize:0,candidateCube:null,tile:null,ready:!1,job:null,framebuffer:null,stats:null},_.set(f,p)),p}a($e,"familyState");function*He(f,p,x){let v=p;for(x.stage="band-wait";;){let O=Nr(e,f),N=n();if(O)return e.deleteSync(f),x.stage="bands",v-p+(N-v)/2;v=N,yield gr}}a(He,"awaitFence");function*We(f,p,x,v,O,N,X,ie){for(let S=0;S<O;S+=N){if(X.cancelled)return!1;let le=Math.min(N,O-S),ue=n(),oe=ce();e.bindFramebuffer(e.DRAW_FRAMEBUFFER,f.framebuffer),x>=0?e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_CUBE_MAP_POSITIVE_X+x,v,0):e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,v,0),e.viewport(0,0,O,O),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.disable(e.CULL_FACE),e.enable(e.SCISSOR_TEST),e.scissor(0,S,O,le),e.useProgram(p.program),e.uniform1i(p.uniforms.get("u_face"),x),e.uniform1f(p.uniforms.get("u_size"),O),e.bindVertexArray(B),e.drawArrays(e.TRIANGLES,0,3),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,null,0),x<0&&S+le>=O&&(e.activeTexture(e.TEXTURE0+To),e.bindTexture(e.TEXTURE_2D,v),e.generateMipmap(e.TEXTURE_2D));let at=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0);e.flush(),re(oe),ie.issueMs+=n()-ue;let Fe=yield*He(at,ue,X);ie.gpuMs+=Fe,ie.maxBandMs=Math.max(ie.maxBandMs,Fe),ie.texels+=O*le,ie.bands+=1}return!0}a(We,"bakeTarget");function Ye(f,p){let x=p===null?ca:Math.min(ca,ps/p);return Math.max(1,Math.min(f,Math.floor(x/f)))}a(Ye,"rowsPerBandFor");function Se(f){let p=Ne(e.TEXTURE_CUBE_MAP,yr);return e.texStorage2D(e.TEXTURE_CUBE_MAP,1,e.RGBA8,f,f),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),p}a(Se,"createCube");function*M(f,p){let x=la[f],v=$e(f),O={family:f,startedAt:p.startedAt,programsReadyMs:0,levels:[],cubeSize:0,texelRateMs:null,readyMs:0,wallMs:0,cpuMs:0,bytes:0};v.stats=O;let N=[x.draw];x.bake&&N.push(x.bake),x.motes&&N.push("draw:motes"),p.stage="compile";let X=yield*ze(N);if(p.stage="allocate",O.programsReadyMs=n()-p.startedAt,!X.some(ie=>ie.failed)){if(x.motes&&V(),x.bake){let ie=T.get(x.bake),S=Math.round(gt*gt*4*4/3),le=a(ne=>({size:ne,bands:0,gpuMs:0,maxBandMs:0,issueMs:0,texels:0,wallMs:0}),"newLevel"),ue=null;v.framebuffer??=e.createFramebuffer();let oe=hs,at=ce(),Fe=Se(oe);re(at),yield,p.stage="bands";let Le=le(oe),Pe=n();for(let ne=0;ne<6;ne++)if(!(yield*We(v,ie,ne,Fe,oe,Ye(oe,ue),p,Le))){Ke(e,Fe);return}Le.wallMs=n()-Pe,O.levels.push(Le),ue=Le.gpuMs/Le.texels,O.texelRateMs=ue,v.cube=Fe,v.cubeSize=oe,O.cubeSize=oe,O.bytes=oe*oe*6*4+S,b+=O.bytes;let it=ce();v.tile=Ne(e.TEXTURE_2D,To),e.texStorage2D(e.TEXTURE_2D,Math.log2(gt)+1,e.RGBA8,gt,gt),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.REPEAT),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.REPEAT),re(it),yield;let et=le(gt),rt=n();if(!(yield*We(v,ie,-1,v.tile,gt,Ye(gt,ue),p,et)))return;for(et.wallMs=n()-rt,O.tile=et,O.readyMs=n()-p.startedAt,v.ready=!0,d+=1,o(),J();oe<ds;){let ne=oe*2;if(ue*ne*ne*6>ms)break;let Kt=ce();Fe=Se(ne),re(Kt),v.candidateCube=Fe,yield,Le=le(ne);let Nt=n(),st=!0;for(let Tt=0;Tt<6&&st;Tt++)st=yield*We(v,ie,Tt,Fe,ne,Ye(ne,ue),p,Le);if(!st){Ke(e,Fe),v.candidateCube=null;return}Le.wallMs=n()-Nt,O.levels.push(Le),ue=Le.gpuMs/Le.texels,O.texelRateMs=ue,Ke(e,v.cube),v.cube=Fe,v.candidateCube=null,b+=ne*ne*6*4-oe*oe*6*4,O.bytes+=ne*ne*6*4-oe*oe*6*4,oe=ne,v.cubeSize=oe,O.cubeSize=oe,d+=1,o()}O.wallMs=n()-p.startedAt,O.cpuMs=p.cpuMs,v.job=null;return}O.wallMs=n()-p.startedAt,O.cpuMs=p.cpuMs,v.ready=!0,v.job=null,d+=1,o(),J()}}a(M,"bakeFamily");function j(f){let p=$e(f);return p.ready||p.job!==null||(p.job=$(`bake ${f}`,x=>M(f,x),!0)),p}a(j,"ensureFamily");function W(f){for(let[p,x]of _)p!==f&&(D(x.job),x.job=null,(x.cube||x.tile)&&(b-=x.stats?.bytes??0),x.cube&&Ke(e,x.cube),x.candidateCube&&Ke(e,x.candidateCube),x.tile&&Ke(e,x.tile),x.framebuffer&&e.deleteFramebuffer(x.framebuffer),x.cube=null,x.cubeSize=0,x.candidateCube=null,x.tile=null,x.framebuffer=null,x.ready=!1)}a(W,"evictFamiliesExcept");let Z=new Set;function J(){for(let f of[...Z])f.check()&&(Z.delete(f),f.resolve())}a(J,"notifyReady");function Y(f){let p=g.get(f);return p||(p={generation:-1,tints:null,tintLook:null,tintJob:null,shadowKey:null,checkedKey:null,shadowJob:null,shadowTexture:null,shadowSpare:null,shadowPacked:null,shadowWindow:[0,0,1],shadowStats:null},g.set(f,p)),p}a(Y,"paneState");function Q(f){return f.defaultTints.map(p=>Xo(p,.85))}a(Q,"lookTintsLinear");function*de(f,p,x,v){let O=Y(f),N=Q(x);if(p!==null&&p.colors instanceof Uint8Array&&p.colors.length>0){let X=fn(p.colors,p.visibility,3,65536);if(yield,v.cancelled)return;if(X.colors.length>0){let ie=x.tone==="dark"?.8:.6;N=[0,1,2].map(S=>Xo(X.colors[Math.min(S,X.colors.length-1)],ie))}}O.tints=N,O.tintLook=x.id,O.tintJob=null,J(),d+=1,o()}a(de,"computeTints");function Ee(f,p){return f.tints===null||f.tintLook!==p.id?null:f.tints}a(Ee,"currentTints");function*Oe(f,p,x,v,O,N){let X=Y(f),ie=n(),S=jt;N.stage="shadow-allocate";let le=new Float32Array(S*S),ue=new Float32Array(S*S),oe=new Float32Array(S*S),at=new Float32Array(S*S),{positions:Fe,dimension:Le,visibility:Pe}=p,it=Math.floor(Fe.length/Le),et,rt,G,ne,Mt,Kt=0,Nt=v?Math.max(x.extentZ*2+Gt,Gt):Math.max(x.extentY*2+.12,.12);if(v){let K=[-.45,.55,.7];ne=-K[0]/K[2],Mt=-K[1]/K[2],Kt=x.stageZ-x.extentZ-Gt,et=x.stageX,rt=x.centerY,G=Math.max(x.extentX,x.extentY)*1.3+Nt*.8+.3}else{ne=-Ct[0]/Ct[1],Mt=-Ct[2]/Ct[1],et=x.stageX,rt=x.stageZ;let K=Nt*Math.hypot(ne,Mt);G=Math.max(x.extentX,x.extentZ)*1.25+K*.6+.35}let st=S/(2*G),Tt=et-G,Er=rt-G,Vt=Math.max(1,Math.floor(it/2e6)),_r=4e4,Ar=0;N.stage="shadow-splat";for(let K=0;K<it;K+=_r*Vt){let Je=Math.min(it,K+_r*Vt);for(let Ue=K;Ue<Je;Ue+=Vt){let ft=Pe===null||Pe[Ue]!==0?1:0;if(ft<=0)continue;let St=Ue*Le,je=Fe[St],Dt=Le>1?Fe[St+1]:0,Tr=Le>2?Fe[St+2]:0,Sr,kr,Bt,Jt,Qt;v?(Bt=Tr-Kt,Jt=je,Qt=Dt):(Bt=Dt-x.floorY,Jt=je,Qt=Tr),Sr=Jt+ne*Bt,kr=Qt+Mt*Bt,Ar+=ft;let Co=Math.min(1,Math.max(0,Bt/Nt)),eo=(Sr-Tt)*st-.5,to=(kr-Er)*st-.5,ut=Math.floor(eo),dt=Math.floor(to);if(ut>=0&&dt>=0&&ut<S-1&&dt<S-1){let oo=eo-ut,ro=to-dt,ht=dt*S+ut,no=ft*(1-Co),ao=ft*Co,Rr=(1-oo)*(1-ro),Cr=oo*(1-ro),$r=(1-oo)*ro,Or=oo*ro;le[ht]+=no*Rr,le[ht+1]+=no*Cr,le[ht+S]+=no*$r,le[ht+S+1]+=no*Or,ue[ht]+=ao*Rr,ue[ht+1]+=ao*Cr,ue[ht+S]+=ao*$r,ue[ht+S+1]+=ao*Or}eo=(Jt-Tt)*st,to=(Qt-Er)*st,ut=eo|0,dt=to|0,ut>=0&&dt>=0&&ut<S&&dt<S&&(oe[dt*S+ut]+=ft*Math.exp(-Co*2.2))}if(yield,N.cancelled)return}let Ro=st,ma=Math.max(1,Math.round(Ro*.035)),ba=Math.max(2,Math.round(Ro*.11)),xa=Math.max(3,Math.round(Ro*.16));if(N.stage="shadow-blur",yield*vr(le,S,ma,3,at),N.cancelled||(yield*vr(ue,S,ba,3,at),N.cancelled)||(yield*vr(oe,S,xa,3,at),N.cancelled))return;let Mr=a(K=>{let Je=0;for(let je=0;je<K.length;je++)K[je]>Je&&(Je=K[je]);if(!(Je>0))return 1;let Ue=new Uint32Array(1024),ft=0;for(let je=0;je<K.length;je++){let Dt=K[je];Dt>0&&(Ue[Math.min(1023,Math.floor(Dt/Je*1024))]+=1,ft+=1)}let St=ft*.97;for(let je=0;je<1024;je++)if(St-=Ue[je],St<=0)return(je+1)/1024*Je;return Je},"percentile");for(let K=0;K<le.length;K++)le[K]+=ue[K]*.8;N.stage="shadow-normalise";let ya=Mr(le);yield;let ga=Mr(oe);yield;let Zt=new Uint16Array(S*S*2),qt=64;N.stage="shadow-pack";for(let K=0;K<S;K+=qt){let Je=Math.min(S,K+qt)*S;for(let Ue=K*S;Ue<Je;Ue++)Zt[Ue*2]=So(1-Math.exp(-1.4*le[Ue]/ya)),Zt[Ue*2+1]=So(1-Math.exp(-1.2*oe[Ue]/ga));if(yield,N.cancelled)return}if(N.cancelled)return;N.stage="shadow-upload";let It=X.shadowSpare;if(It===null){let K=ce();It=Ne(e.TEXTURE_2D,zt),e.texStorage2D(e.TEXTURE_2D,1,e.RG16F,S,S),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),re(K),b+=S*S*4,X.shadowSpare=It,yield}for(let K=0;K<S;K+=qt){if(N.cancelled)return;let Je=Math.min(qt,S-K),Ue=ce();e.activeTexture(e.TEXTURE0+zt),e.bindTexture(e.TEXTURE_2D,It),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texSubImage2D(e.TEXTURE_2D,0,0,K,S,Je,e.RG,e.HALF_FLOAT,Zt.subarray(K*S*2,(K+Je)*S*2)),re(Ue),yield}N.cancelled||(X.shadowSpare=X.shadowTexture,X.shadowTexture=It,X.shadowWindow=[et,rt,G],X.shadowPacked=Zt,X.shadowKey=O,J(),X.shadowJob=null,X.shadowStats={points:it,visible:Math.round(Ar),stride:Vt,wallMs:n()-ie,cpuMs:N.cpuMs},d+=1,o())}a(Oe,"bakeShadow");function ae(f,p,x,v){let O=Y(f),N=r(f),X=N===null?0:N.generation;if((X!==O.generation||O.tintLook!==p.id)&&O.tintJob===null&&(O.generation=X,O.tintJob=$(`tints ${f}`,ie=>de(f,N,p,ie))),p.family==="atelier"&&p.program==="atelier"&&N!==null&&N.positions.length>0){O.positionsRef!==N.positions&&(O.positionsRef=N.positions,O.positionsEpoch=(O.positionsEpoch??0)+1);let ie=[O.positionsEpoch,N.positions.length,N.dimension,v?1:0,x.floorY.toFixed(5),x.stageX.toFixed(5),x.stageZ.toFixed(5)].join("|"),S=`${ie}|${X}`;if(S!==O.checkedKey){O.checkedKey=S,D(O.shadowJob);let le={...x};O.shadowJob=$(`shadow ${f}`,function*(ue){ue.stage="shadow-signature";let oe=`${ie}|${bs(N.visibility)}`;if(yield,!ue.cancelled){if(oe===O.shadowKey){O.shadowJob=null;return}yield*Oe(f,N,le,v,oe,ue)}})}}return O}a(ae,"syncPane");function se(){return u&&l!==null&&!t()&&(typeof document>"u"||document.visibilityState!=="hidden")&&(l==="nebula"||l==="aurora-dark"||l.startsWith("abyss"))}a(se,"ambientWanted");function ke(){if(m=null,!se())return;let f=n();A+=Math.min(.1,(f-y)/1e3),y=f,d+=1,o(),m=setTimeout(ke,1e3/30)}a(ke,"tickAmbient");function _e(){se()?m===null&&(y=n(),m=setTimeout(ke,1e3/30)):m!==null&&(clearTimeout(m),m=null)}a(_e,"syncAmbient");let fe=a(()=>_e(),"onVisibility");typeof document<"u"&&document.addEventListener("visibilitychange",fe);let ye=typeof matchMedia=="function"?matchMedia("(prefers-reduced-motion: reduce)"):null,Ae=a(()=>{_e(),t()&&h<1&&Me()&&(h=1,d+=1,o())},"onReducedMotion");ye?.addEventListener?.("change",Ae);function Xe(f){let p=f===null?null:f;if(p!==null&&!Rt(p))throw new TypeError(`Unknown backdrop look "${f}".`);if(p===l)return;let x=l===null?null:ct[l].program;if(l=p,d+=1,p!==null){let v=ct[p].program;W(v),h=j(v).ready&&x===v?1:0}else W(null),h=0;_e()}a(Xe,"setLook");function Me(){if(l===null)return!1;let f=_.get(ct[l].program);return f!==void 0&&f.ready}a(Me,"isLookReady");function Ie(f){l!==null&&Me()&&h<1&&(h=t()?1:Math.min(1,h+f/.35),d+=1)}a(Ie,"advance");function Be(){return l===null?null:Me()&&h<1?"backdrop-fade":null}a(Be,"frameCause");function he(f,p,x){let v=f.uniforms.get(p);v!==void 0&&e.uniform3f(v,x[0],x[1],x[2])}a(he,"setUniform3");function me(f,p,x){let v=f.uniforms.get(p);v!==void 0&&e.uniform1f(v,x)}a(me,"setUniform1");function ge(f,p,x){let v=f.uniforms.get(p);v!==void 0&&e.uniform4f(v,x[0],x[1],x[2],x[3])}a(ge,"setUniform4");let pe=null,Ze=null;function ee(f){return f===null?{texture:null,window:[0,0,1],ready:!1}:(Ze!==f.packed&&(pe===null?(pe=Ne(e.TEXTURE_2D,zt),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE)):(e.activeTexture(e.TEXTURE0+zt),e.bindTexture(e.TEXTURE_2D,pe)),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texImage2D(e.TEXTURE_2D,0,e.RG16F,f.size,f.size,0,e.RG,e.HALF_FLOAT,f.packed),Ze=f.packed),{texture:pe,window:f.window,ready:!0})}a(ee,"frozenShadow");let q=[[0,0,0],[0,0,0],[0,0,0]];function te(f){if(s||l===null)return!1;let p=ct[l],x=p.program,v=_.get(x),O=la[x],N=f.frozen??null,X=N===null?ae(f.viewId,p,f.geometry,f.planar===1):null,ie=N===null?h:1;if(!v||!v.ready||ie<=0)return!1;let S=T.get(O.draw);if(!S||!S.ready)return!1;let le=f.ndcTransform??fs,ue=N===null?A:N.time,oe=N!==null?N.tints:Ee(X,p)??Q(p);for(let G=0;G<3;G++)q[G][0]=oe[G][0],q[G][1]=oe[G][1],q[G][2]=oe[G][2];let at=H.isEnabled(e.BLEND),Fe=H.isEnabled(e.DEPTH_TEST),Le=H.activeTexture,Pe=f.geometry;e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.depthMask(!1),e.useProgram(S.program),e.uniformMatrix4fv(S.uniforms.get("u_invMvp"),!1,f.invMvp),e.uniform3f(S.uniforms.get("u_eye"),f.eye[0],f.eye[1],f.eye[2]),me(S,"u_pixelRatio",f.pixelRatio);let it=S.uniforms.get("u_viewport");it!==void 0&&e.uniform2f(it,f.viewportWidth,f.viewportHeight),me(S,"u_glowCenterX",f.glowCenterX),me(S,"u_opacity",ie),ge(S,"u_ndcTransform",le);let et=p.surface;if(he(S,"u_surface",[et[0]/255,et[1]/255,et[2]/255]),me(S,"u_planar",f.planar),he(S,"u_stageCenter",[Pe.stageX,Pe.centerY,Pe.stageZ]),he(S,"u_stageExtent",[Pe.extentX,Pe.extentY,Pe.extentZ]),me(S,"u_floorY",Pe.floorY),me(S,"u_time",ue),me(S,"u_ambient",N===null?m!==null?1:0:N.ambient),me(S,"u_dark",p.tone==="dark"?1:0),he(S,"u_tint0",q[0]),he(S,"u_tint1",q[1]),he(S,"u_tint2",q[2]),v.cube){e.activeTexture(e.TEXTURE0+yr),e.bindTexture(e.TEXTURE_CUBE_MAP,v.cube);let G=S.uniforms.get("u_sky");G!==void 0&&e.uniform1i(G,yr)}if(v.tile){e.activeTexture(e.TEXTURE0+To),e.bindTexture(e.TEXTURE_2D,v.tile);let G=S.uniforms.get("u_tile");G!==void 0&&e.uniform1i(G,To)}if(x==="atelier"){let G=N===null?{texture:X.shadowTexture,window:X.shadowWindow,ready:X.shadowTexture!==null&&X.shadowKey!==null}:ee(N.shadow);e.activeTexture(e.TEXTURE0+zt),e.bindTexture(e.TEXTURE_2D,G.texture);let ne=S.uniforms.get("u_shadow");ne!==void 0&&e.uniform1i(ne,zt),he(S,"u_shadowWindow",G.window),me(S,"u_shadowReady",G.ready?1:0),he(S,"u_keyLight",Ct),me(S,"u_paperGap",Gt)}e.bindVertexArray(B),e.drawArrays(e.TRIANGLES,0,3);let rt=null;if(O.motes&&k!==null){let G=T.get("draw:motes");if(G&&G.ready){let ne=H.blendFunc;rt=[ne.srcRgb,ne.dstRgb,ne.srcAlpha,ne.dstAlpha],e.useProgram(G.program),e.enable(e.BLEND),p.tone==="dark"?e.blendFuncSeparate(e.ONE,e.ONE,e.ZERO,e.ONE):e.blendFuncSeparate(e.ONE,e.ONE_MINUS_SRC_ALPHA,e.ZERO,e.ONE),e.uniformMatrix4fv(G.uniforms.get("u_mvp"),!1,f.mvp),he(G,"u_eye",f.eye),he(G,"u_stageCenter",[Pe.stageX,Pe.centerY,Pe.stageZ]),he(G,"u_stageExtent",[Pe.extentX,Pe.extentY,Pe.extentZ]),me(G,"u_projScale",f.projection[5]),me(G,"u_viewportHeight",f.viewportHeight),me(G,"u_pixelRatio",f.pixelRatio),me(G,"u_time",ue),ge(G,"u_ndcTransform",le),me(G,"u_planar",f.planar),me(G,"u_dark",p.tone==="dark"?1:0),me(G,"u_opacity",ie),me(G,"u_maxPointSize",c),he(G,"u_tint0",q[0]),he(G,"u_tint1",q[1]),e.bindVertexArray(k),e.drawArrays(e.POINTS,0,wr)}}return e.bindVertexArray(null),e.depthMask(!0),(at?e.enable:e.disable).call(e,e.BLEND),rt!==null&&e.blendFuncSeparate(...rt),(Fe?e.enable:e.disable).call(e,e.DEPTH_TEST),e.activeTexture(Le),!0}a(te,"draw");function we(f){let p=g.get(f);if(p){D(p.tintJob),D(p.shadowJob);for(let x of[p.shadowTexture,p.shadowSpare])x!==null&&(Ke(e,x),b-=jt*jt*4);g.delete(f),ko.delete(f)}}a(we,"forgetView");function qe(f){if(!s){s=!0,F(),w.length=0,m!==null&&clearTimeout(m),m=null,typeof document<"u"&&document.removeEventListener("visibilitychange",fe),ye?.removeEventListener?.("change",Ae);for(let p of Z)p.reject(new Error("Backdrop look renderer disposed."));if(Z.clear(),!!f){for(let p of T.values())zr(e,p.program),e.deleteShader(p.vs),e.deleteShader(p.fs);for(let p of _.values())p.cube&&Ke(e,p.cube),p.candidateCube&&Ke(e,p.candidateCube),p.tile&&Ke(e,p.tile),p.framebuffer&&e.deleteFramebuffer(p.framebuffer);for(let p of g.values())p.shadowTexture&&Ke(e,p.shadowTexture),p.shadowSpare&&Ke(e,p.shadowSpare);pe&&Ke(e,pe),e.deleteVertexArray(B),e.deleteBuffer(I),k&&e.deleteVertexArray(k),U&&e.deleteBuffer(U)}}}a(qe,"teardown");function nt(){let f={};for(let[x,v]of _)f[x]={ready:v.ready,...v.stats??{}};let p={};for(let[x,v]of g)p[x]=v.shadowStats;return{activeId:l,opacity:h,version:d,textureBytes:b,jobsQueued:w.length,jobHistory:C.slice(),slices:{...z},families:f,shadows:p,ambient:m!==null,parallelCompile:i!==null,programs:[...T.values()].map(x=>({key:x.key,ready:x.ready,failed:x.failed,compileMs:x.readyAt?x.readyAt-x.startedAt:null}))}}a(nt,"getDiagnostics");function ha(f){if(l===null)return null;let p=ct[l],x=g.get(f)??null,v=(x&&Ee(x,p))??null,O=p.program==="atelier"?x?.shadowPacked??null:null,N=m!==null?1:0,X=ko.get(f);if(X!==void 0&&X.id===l&&X.tintsRef===v&&X.packed===O&&X.state.time===A&&X.state.ambient===N)return X.state;let ie=v??Q(p),S=Object.freeze({id:l,tints:Object.freeze(ie.map(le=>Object.freeze([le[0],le[1],le[2]]))),time:A,ambient:N,shadow:O===null?null:Object.freeze({packed:O,window:Object.freeze([...x.shadowWindow]),size:jt})});return ko.set(f,{id:l,tintsRef:v,packed:O,state:S}),S}a(ha,"getExportState");let ko=new Map;function pa(){let f=a(()=>Me(),"check");return f()?Promise.resolve():new Promise((p,x)=>Z.add({check:f,resolve:p,reject:x}))}return a(pa,"whenReady"),{setLook:Xe,advance:Ie,getExportState:ha,whenReady:pa,frameCause:Be,draw:te,forgetView:we,dispose:a(()=>qe(!0),"dispose"),abandon:a(()=>qe(!1),"abandon"),isActive:a(()=>l!==null,"isActive"),getVersion:a(()=>d,"getVersion"),setAmbientMotion(f){u=f===!0,_e()},getDiagnostics:nt}}a(ua,"createBackdropLookRenderer");var Yt=null;function xs(){if(Yt!==null&&!Yt.gl.isContextLost())return Yt;if(typeof document>"u")throw new Error("Figure export needs a document to draw the background look.");let e=document.createElement("canvas");e.width=1,e.height=1;let o=e.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,preserveDrawingBuffer:!0});if(!o)throw new Error("Figure export needs WebGL2 to draw the background look.");let t=ua(o,{invalidate:a(()=>{},"invalidate"),prefersReducedMotion:a(()=>!0,"prefersReducedMotion"),readViewSource:a(()=>null,"readViewSource")});return Yt={canvas:e,gl:o,renderer:t},Yt}a(xs,"getSharedContext");function ys(e){let o=new Float32Array(16),t=e[0],r=e[1],n=e[2],i=e[3],c=e[4],s=e[5],l=e[6],h=e[7],d=e[8],u=e[9],m=e[10],A=e[11],y=e[12],b=e[13],T=e[14],_=e[15],g=t*s-r*c,w=t*l-n*c,C=t*h-i*c,E=r*l-n*s,L=r*h-i*s,z=n*h-i*l,P=d*b-u*y,F=d*T-m*y,R=d*_-A*y,$=u*T-m*b,D=u*_-A*b,B=m*_-A*T,I=g*B-w*D+C*$+E*R-L*F+z*P;if(!Number.isFinite(I)||Math.abs(I)<1e-30)return null;let k=1/I;return o[0]=(s*B-l*D+h*$)*k,o[1]=(n*D-r*B-i*$)*k,o[2]=(b*z-T*L+_*E)*k,o[3]=(m*L-u*z-A*E)*k,o[4]=(l*R-c*B-h*F)*k,o[5]=(t*B-n*R+i*F)*k,o[6]=(T*C-y*z-_*w)*k,o[7]=(d*z-m*C+A*w)*k,o[8]=(c*D-s*R+h*P)*k,o[9]=(r*R-t*D-i*P)*k,o[10]=(y*L-b*C+_*g)*k,o[11]=(u*C-d*L-A*g)*k,o[12]=(s*F-c*$-l*P)*k,o[13]=(t*$-r*F+n*P)*k,o[14]=(b*w-y*E-T*g)*k,o[15]=(d*E-u*w+m*g)*k,o}a(ys,"invert4");async function da({renderState:e,width:o,height:t,ndcTransform:r,pixelScale:n,signal:i=null}){let c=e?.backdrop?.look??null;if(c===null||!Rt(c.id))throw new TypeError("Figure export render state names no background look.");if(!(Number.isInteger(o)&&o>0&&Number.isInteger(t)&&t>0))throw new TypeError("Figure export background-look raster needs a positive integer size.");let{canvas:s,gl:l,renderer:h}=xs();h.setLook(c.id),await h.whenReady(),Br(i);let d=Math.min(l.getParameter(l.MAX_RENDERBUFFER_SIZE),...l.getParameter(l.MAX_VIEWPORT_DIMS)),u=Math.min(1,d/o,d/t),m=Math.max(1,Math.floor(o*u)),A=Math.max(1,Math.floor(t*u));s.width=m,s.height=A,l.viewport(0,0,m,A);let y=Float32Array.from(e.mvpMatrix),b=ys(y);if(b===null)throw new Error("Figure export cannot draw the background look: the camera is singular.");let T=e.backdrop,_=n*u;if(!h.draw({viewId:"figure-export",invMvp:b,mvp:y,projection:Float32Array.from(e.projectionMatrix),eye:Float32Array.from(e.cameraPosition),pixelRatio:T.pixelRatio*_,glowCenterX:T.glowCenterX,viewportWidth:e.viewportWidth*_,viewportHeight:e.viewportHeight*_,planar:T.planarity>=.5?1:0,geometry:T,ndcTransform:r,frozen:c}))throw new Error(`Figure export could not draw the "${c.id}" background look.`);let w=document.createElement("canvas");w.width=o,w.height=t;let C=w.getContext("2d");return C.imageSmoothingEnabled=!0,C.imageSmoothingQuality="high",C.drawImage(s,0,0,o,t),w}a(da,"renderBackdropLookRaster");function hf(e,o,t){return e?.kind==="look"&&o?.viewerPaper===!0&&t?.backdrop?.look!=null}a(hf,"figureDrawsBackdropLook");function gs({renderState:e,plotRect:o,crop:t=null}){let r=Lt({renderState:e,plotRect:o,crop:t}),n=r.viewportToPlot(r.srcX0,r.srcY0),i=r.viewportW,c=r.viewportH,s=a(u=>(u-n.x)/r.scale+r.srcX0,"toViewportX"),l=a(u=>(u-n.y)/r.scale+r.srcY0,"toViewportY"),h=o.x+o.width/2,d=o.y+o.height/2;return{ndcTransform:[o.width/r.scale/i,o.height/r.scale/c,2*s(h)/i-1,1-2*l(d)/c],viewportPerPlot:1/r.scale}}a(gs,"resolveBackdropLookPlacement");async function ws({renderState:e,plotRect:o,crop:t=null,width:r,height:n,signal:i=null}){let{ndcTransform:c,viewportPerPlot:s}=gs({renderState:e,plotRect:o,crop:t}),l=r/o.width/s;return da({renderState:e,width:r,height:n,ndcTransform:c,pixelScale:l,signal:i})}a(ws,"renderBackdropLookForPlot");function pf(e,o){return`<image class="cellucid-backdrop-look" x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" href="${e}" preserveAspectRatio="none"/>`}a(pf,"renderSvgBackdropLookImage");var ot={key:null,canvas:null,pending:null};function mf({renderState:e,plotRect:o,crop:t,width:r,height:n},i){let c=e.backdrop.look,s=JSON.stringify([c.id,c.tints,c.time,c.shadow?.window??null,Array.from(e.mvpMatrix),e.viewportWidth,e.viewportHeight,o,t,r,n]);return ot.key===s&&ot.canvas!==null?ot.canvas:(ot.pending!==s&&(ot.pending=s,ws({renderState:e,plotRect:o,crop:t,width:r,height:n}).then(l=>{ot.pending===s&&(ot.key=s,ot.canvas=l,ot.pending=null,i())}).catch(l=>{ot.pending===s&&(ot.pending=null),console.warn("[FigureExport] Background-look preview failed:",l)})),null)}a(mf,"peekBackdropLookPreview");export{Vl as a,br as b,Ge as c,Do as d,mt as e,De as f,Ts as g,Bo as h,Ut as i,Ss as j,en as k,ks as l,tn as m,on as n,Rt as o,ln as p,ua as q,vs as r,_a as s,wt as t,co as u,Es as v,_s as w,rn as x,ka as y,sn as z,ho as A,Sn as B,yo as C,Qo as D,Fc as E,Lc as F,er as G,kn as H,Cn as I,xi as J,Xt as K,$n as L,yi as M,Pc as N,zc as O,gi as P,wi as Q,Nc as R,Ic as S,Dc as T,Bc as U,Hc as V,Wc as W,Yc as X,Kc as Y,Vc as Z,Us as _,js as $,mn as aa,Ja as ba,ec as ca,tc as da,oc as ea,ei as fa,rc as ga,nc as ha,lt as ia,$t as ja,fc as ka,vc as la,Ec as ma,_c as na,tl as oa,ol as pa,rl as qa,nl as ra,dl as sa,hl as ta,wl as ua,vl as va,kl as wa,Rl as xa,Gl as ya,Xl as za,Hl as Aa,Wl as Ba,hf as Ca,ws as Da,pf as Ea,mf as Fa};
