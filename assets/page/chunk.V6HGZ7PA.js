import{E as Xo,Q as Vr,R as Zr,V as Qr,y as Wr}from"./chunk.XTIB4P5B.js";import{$a as tn,D as Br,O as Go,R as Ur,Ta as qr,Wa as Jr,_a as en,ab as on,bb as Pt,cb as rn,fb as nn,nb as an,qb as Ko,u as Dr,v as Qe}from"./chunk.CGLMZ7VO.js";import{b as Hr}from"./chunk.FE2T35QV.js";import{F as Yr,g as Xr,i as dt,j as Kr,k as Lt,q as St}from"./chunk.MONMEDZM.js";import{b as ce,f as Ne}from"./chunk.5EODKS5P.js";import{d as xo,g as We,q as jo,r as Gr,t as Zt,v as jr}from"./chunk.M7VME5XV.js";import{i as Ct,p as Nr}from"./chunk.XYMIX5KS.js";import{a}from"./chunk.BLB2Q6XA.js";var cn=new Set(["orbit","planar","free"]),Yi=Object.freeze(["navigationMode","orbit","freefly"]),Hi=Object.freeze(["radius","targetRadius","theta","phi","target"]),Vi=Object.freeze(["position","yaw","pitch"]);function Wo(e,t){if(e===null||typeof e!="object"||Array.isArray(e)||Object.getPrototypeOf(e)!==Object.prototype)return!1;let o=0;for(let r in e)Object.hasOwn(e,r)&&o++;if(o!==t.length)return!1;for(let r=0;r<t.length;r++)if(!Object.prototype.propertyIsEnumerable.call(e,t[r]))return!1;return!0}a(Wo,"hasExactKeys");function sn(e){return Array.isArray(e)&&e.length===3&&Number.isFinite(e[0])&&Number.isFinite(e[1])&&Number.isFinite(e[2])}a(sn,"isFiniteVec3");function Ol(e){if(!cn.has(e))throw new RangeError(`Navigation mode must be exactly "orbit", "planar", or "free"; received ${String(e)}.`);return e}a(Ol,"assertNavigationMode");function Zi(e){if(!Wo(e,Yi)||!cn.has(e.navigationMode))return!1;let t=e.orbit,o=e.freefly;return!!(Wo(t,Hi)&&Number.isFinite(t.radius)&&t.radius>0&&Number.isFinite(t.targetRadius)&&t.targetRadius>0&&Number.isFinite(t.theta)&&Number.isFinite(t.phi)&&sn(t.target)&&Wo(o,Vi)&&sn(o.position)&&Number.isFinite(o.yaw)&&Number.isFinite(o.pitch))}a(Zi,"isExactCameraState");function st(e,t="Camera state"){if(!Zi(e))throw new TypeError(`${t} must contain an exact navigationMode plus complete orbit and freefly state.`);return e}a(st,"assertCameraState");function zl(e,t="Camera state"){let o=st(e,t);return{navigationMode:o.navigationMode,orbit:{radius:o.orbit.radius,targetRadius:o.orbit.targetRadius,theta:o.orbit.theta,phi:o.orbit.phi,target:[...o.orbit.target]},freefly:{position:[...o.freefly.position],yaw:o.freefly.yaw,pitch:o.freefly.pitch}}}a(zl,"cloneCameraState");function ln(e,t){return e[0]===t[0]&&e[1]===t[1]&&e[2]===t[2]}a(ln,"sameVec3");function Cl(e,t){let o=st(e,"Compared camera state"),r=st(t,"Compared camera state");return o.navigationMode!==r.navigationMode||!ln(o.orbit.target,r.orbit.target)?!1:o.navigationMode==="free"?ln(o.freefly.position,r.freefly.position)&&o.freefly.yaw===r.freefly.yaw&&o.freefly.pitch===r.freefly.pitch:o.orbit.radius===r.orbit.radius&&o.orbit.targetRadius===r.orbit.targetRadius&&o.orbit.theta===r.orbit.theta&&o.orbit.phi===r.orbit.phi}a(Cl,"cameraStatesHaveSamePose");var qi=3,Ji=Math.PI/4,Qi=Math.PI/4;function Ll(){let e=qi,t=Ji,o=Qi,r=[0,0,0],i=[e*Math.sin(o)*Math.cos(t),e*Math.cos(o),e*Math.sin(o)*Math.sin(t)],n=[r[0]+i[0],r[1]+i[1],r[2]+i[2]],s=[-i[0]/e,-i[1]/e,-i[2]/e];return{orbit:{radius:e,theta:t,phi:o,target:r},freefly:{position:n,yaw:Math.atan2(s[2],s[0]),pitch:Math.asin(s[1])}}}a(Ll,"createDefaultCameraPose");function ea({navigationMode:e,target:t,radius:o,theta:r,phi:i}){if(e!=="orbit"&&e!=="planar")throw new RangeError(`An orbit pose is navigated by orbit or planar; received ${String(e)}.`);let n=e==="planar"?[0,0,o]:[o*Math.sin(i)*Math.cos(r),o*Math.cos(i),o*Math.sin(i)*Math.sin(r)],s=n.map(f=>-f/o);return st({navigationMode:e,orbit:{radius:o,targetRadius:o,theta:r,phi:i,target:[t[0],t[1],t[2]]},freefly:{position:[t[0]+n[0],t[1]+n[1],t[2]+n[2]],yaw:Math.atan2(s[2],s[0]),pitch:Math.asin(Math.max(-1,Math.min(1,s[1])))}},"Orbit camera pose")}a(ea,"cameraStateForOrbitPose");function Pl(e){if(e.navigationMode==="free")return e;let{freefly:t}=ea({navigationMode:e.navigationMode,target:e.orbit.target,radius:e.orbit.radius,theta:e.orbit.theta,phi:e.orbit.phi}),o=Math.max(1,e.orbit.radius),r=a((n,s)=>Math.abs(Math.atan2(Math.sin(n-s),Math.cos(n-s))),"angle");return t.position.every((n,s)=>Math.abs(n-e.freefly.position[s])<=1e-4*o)&&r(t.yaw,e.freefly.yaw)<=1e-4&&Math.abs(t.pitch-e.freefly.pitch)<=1e-4?e:{navigationMode:e.navigationMode,orbit:e.orbit,freefly:t}}a(Pl,"cameraInStep");var qe=Object.freeze({base:1,ratio:5,fadeInFraction:.6}),Vo=Object.freeze({floor:Object.freeze({minCellCssPx:22,maxFamilySpacing:2.5}),backdrop:Object.freeze({minCellCssPx:16,maxFamilySpacing:1/0})}),gt=Object.freeze({lineWidthCssPx:1,majorLineWidthCssPx:1,dotRadiusCssPx:1.05,majorDotRadiusCssPx:1.3}),Ye=Object.freeze({floorClearance:.12,innerRadius:2.6,outerRadius:8.5,grazingFadeStart:.035,grazingFadeEnd:.2,clearanceFade:.06,poolReach:1.8,poolRoundness:.4}),Dl=.3,Zo=Object.freeze({studio:Object.freeze({surface:Object.freeze([236,236,236]),glow:Object.freeze([246,246,246]),ink:Object.freeze([96,96,96]),lineMinorAlpha:.15,lineMajorAlpha:.28,dotMinorAlpha:.32,dotMajorAlpha:.42,poolAlpha:.09}),"studio-dark":Object.freeze({surface:Object.freeze([17,17,17]),glow:Object.freeze([27,27,27]),ink:Object.freeze([200,200,200]),lineMinorAlpha:.12,lineMajorAlpha:.22,dotMinorAlpha:.26,dotMajorAlpha:.34,poolAlpha:.09})});function qt(e){return[e[0]/255,e[1]/255,e[2]/255]}a(qt,"studioColor01");function kt(e,t,o){let r=Math.max(0,Math.min(1,(o-e)/(t-e)));return r*r*(3-2*r)}a(kt,"smoothstep");function ta(e,t,o){let r=e.minCellCssPx,i=e.maxFamilySpacing;return{presence:kt(r*qe.fadeInFraction,r,o)*(i===1/0?1:1-kt(i*.5,i,t)),majorness:kt(r,r*qe.ratio,o)}}a(ta,"studioFamilyWeights");function qo(e){return qe.base*qe.ratio**e}a(qo,"studioFamilySpacing");function fn(e,t,o){return Math.floor(Math.log(t*e.minCellCssPx*o/qe.base)/Math.log(qe.ratio))}a(fn,"studioFamilyLevel");function Jo({surface:e,coarsestLevel:t,level:o,footprint:r,pixelRatio:i,minorAlpha:n,majorAlpha:s}){let f=0,c=0;for(let l=o;l<=Math.min(t,o+2);l++){let u=qo(l),d=ta(e,u,u/r/i),p=d.presence*(n+(s-n)*d.majorness);p>f&&(f=p,c=d.majorness)}return{strength:f,majorness:c}}a(Jo,"studioMarkStrength");function go(e){return 1-kt(0,1,e)}a(go,"studioFalloff");function un(e){return 1-kt(Ye.innerRadius,Ye.outerRadius,e)}a(un,"studioStageFade");function wo(e){return kt(Ye.grazingFadeStart,Ye.grazingFadeEnd,e)}a(wo,"studioGrazingFade");function vo(e){return kt(0,Ye.clearanceFade,e)}a(vo,"studioClearanceFade");function Bl(e,t){return e<3||t==="planar"?1:0}a(Bl,"studioSurfacePlanarity");function dn(e,t){return t.floor=1-e,t.backdrop=e,t}a(dn,"resolveStudioSurfaceWeights");function Ul(e,t,o){let r=e===null?-1:e.min[1];return o.floorY=r-Ye.floorClearance,o.flat=t<3,o.stageX=e===null?0:(e.min[0]+e.max[0])*.5,o.stageZ=e===null?0:(e.min[2]+e.max[2])*.5,o.centerY=e===null?0:(e.min[1]+e.max[1])*.5,o.extentX=e===null?1:(e.max[0]-e.min[0])*.5,o.extentY=e===null?1:(e.max[1]-e.min[1])*.5,o.extentZ=e===null?1:(e.max[2]-e.min[2])*.5,o}a(Ul,"resolveStudioPaneGeometry");function hn(e,t,o){if(t.flat)return o.normalX=0,o.normalY=0,o.normalZ=-1,o.offset=-t.stageZ,o.uX=1,o.uY=0,o.uZ=0,o.vX=0,o.vY=1,o.vZ=0,o;let r=-e[2],i=-e[6],n=-e[10],s=t.extentX*Math.abs(r)+t.extentY*Math.abs(i)+t.extentZ*Math.abs(n)+Ye.floorClearance;return o.normalX=r,o.normalY=i,o.normalZ=n,o.offset=r*t.stageX+i*t.centerY+n*t.stageZ+s,o.uX=e[0],o.uY=e[4],o.uZ=e[8],o.vX=e[1],o.vY=e[5],o.vZ=e[9],o}a(hn,"resolveStudioBackdropPlane");function Yo(e,t,o,r,i){let n=e[3]*t+e[7]*o+e[11]*r+e[15];return n>1e-9?(i[0]=(e[0]*t+e[4]*o+e[8]*r+e[12])/n,i[1]=(e[1]*t+e[5]*o+e[9]*r+e[13])/n,!0):!1}a(Yo,"projectToNdc");var Ho=[0,0],It=[0,0];function pn(e,t,o,r){r.gate=0;let i=t[1]-o.floorY,n=Math.hypot(t[0]-o.stageX,i,t[2]-o.stageZ);if(!(i>0)||!(n>0))return r;let s=vo(i)*wo(i/n);if(!(s>0))return r;let f=Math.max(o.extentX,o.extentZ)*Ye.poolRoundness,c=Math.max(o.extentX,f)*Ye.poolReach,l=Math.max(o.extentZ,f)*Ye.poolReach;if(!(c>0)||!(l>0))return r;let u=o.floorY;if(!Yo(e,o.stageX,u,o.stageZ,Ho)||(r.centerX=Ho[0],r.centerY=Ho[1],!Yo(e,o.stageX+c,u,o.stageZ,It))||(r.axisAX=It[0]-r.centerX,r.axisAY=It[1]-r.centerY,!Yo(e,o.stageX,u,o.stageZ+l,It)))return r;r.axisBX=It[0]-r.centerX,r.axisBY=It[1]-r.centerY;let d=r.axisAX*r.axisBY-r.axisBX*r.axisAY;return Math.abs(d)>1e-9&&(r.gate=s),r}a(pn,"resolveStudioPool");var mn=Object.freeze(["white","grid","studio","atelier","abyss","aurora","black","grid-dark","studio-dark","nebula","abyss-dark","aurora-dark"]),oa=Object.freeze([Object.freeze({label:"Light",backgrounds:Object.freeze(["white","grid","studio","atelier","abyss","aurora"])}),Object.freeze({label:"Dark",backgrounds:Object.freeze(["black","grid-dark","studio-dark","nebula","abyss-dark","aurora-dark"])})]);function Xl(e,t){let[o,r]=oa.map(f=>f.backgrounds),i=t==="dark"?o:r,n=t==="dark"?r:o,s=i.indexOf(e);return s===-1?e:n[s]}a(Xl,"backgroundForTheme");var ra=Object.freeze({white:"White",grid:"Grid (light)",studio:"Studio (light)",atelier:"Atelier (light)",abyss:"Abyss (light)",aurora:"Aurora (light)",black:"Black","grid-dark":"Grid (dark)","studio-dark":"Studio (dark)",nebula:"Nebula (dark)","abyss-dark":"Abyss (dark)","aurora-dark":"Aurora (dark)"}),yn=Object.freeze(["studio","studio-dark"]),bn=Object.freeze(["atelier","abyss","aurora","nebula","abyss-dark","aurora-dark"]),Kl=Object.freeze(["grid","grid-dark"]),Wl=`Viewer background must be exactly one of ${mn.map(e=>`"${e}"`).join(", ")}.`;function xn(e){return mn.includes(e)}a(xn,"isViewerBackground");var ht=Object.freeze({atelier:Object.freeze({id:"atelier",family:"atelier",program:"atelier",tone:"light",label:"Atelier (light)",surface:Object.freeze([238,235,230]),defaultTints:Object.freeze([Object.freeze([.55,.52,.48]),Object.freeze([.5,.52,.56]),Object.freeze([.52,.5,.5])])}),nebula:Object.freeze({id:"nebula",family:"atelier",program:"nebula",tone:"dark",label:"Nebula (dark)",surface:Object.freeze([7,8,14]),defaultTints:Object.freeze([Object.freeze([.36,.42,.95]),Object.freeze([.85,.32,.62]),Object.freeze([.2,.75,.8])])}),abyss:Object.freeze({id:"abyss",family:"abyss",program:"abyss",tone:"light",label:"Abyss (light)",surface:Object.freeze([214,234,234]),defaultTints:Object.freeze([Object.freeze([.2,.7,.75]),Object.freeze([.3,.55,.85]),Object.freeze([.55,.8,.6])])}),"abyss-dark":Object.freeze({id:"abyss-dark",family:"abyss",program:"abyss",tone:"dark",label:"Abyss (dark)",surface:Object.freeze([3,14,21]),defaultTints:Object.freeze([Object.freeze([.15,.85,.85]),Object.freeze([.25,.55,1]),Object.freeze([.45,1,.7])])}),aurora:Object.freeze({id:"aurora",family:"aurora",program:"aurora",tone:"light",label:"Aurora (light)",surface:Object.freeze([236,234,236]),defaultTints:Object.freeze([Object.freeze([1,.72,.55]),Object.freeze([.62,.72,.95]),Object.freeze([.95,.65,.75])])}),"aurora-dark":Object.freeze({id:"aurora-dark",family:"aurora",program:"aurora",tone:"dark",label:"Aurora (dark)",surface:Object.freeze([6,10,22]),defaultTints:Object.freeze([Object.freeze([.25,1,.6]),Object.freeze([.65,.35,1]),Object.freeze([.2,.8,.95])])})}),Vl=Object.freeze(Object.keys(ht));function Nt(e){return typeof e=="string"&&Object.prototype.hasOwnProperty.call(ht,e)}a(Nt,"isBackdropLook");function wn(e){let t=ht[e].surface;return[t[0]/255,t[1]/255,t[2]/255]}a(wn,"backdropLookSurface01");function Qo(e){return e<=.04045?e/12.92:((e+.055)/1.055)**2.4}a(Qo,"srgbToLinear");function gn(e){return .2126*e[0]+.7152*e[1]+.0722*e[2]}a(gn,"linearLuminance");function er(e,t,o=[0,0,0]){let r=[Qo(e[0]),Qo(e[1]),Qo(e[2])],i=Math.max(gn(r),1e-4);for(let s=0;s<3;s++){let f=r[s]/i;o[s]=1+(f-1)*t}let n=Math.max(gn(o),1e-4);for(let s=0;s<3;s++)o[s]=Math.max(0,o[s]/n);return o}a(er,"shapeBackdropTint");function vn(e,t,o=3,r=65536){let i=Math.floor(e.length/4),n=new Float32Array(32768),s=new Float32Array(32768*3),f=Math.max(1,Math.floor(i/r)),c=0;for(let d=0;d<i;d+=f){if(t!==null&&t[d]===0)continue;let p=e[d*4],g=e[d*4+1],v=e[d*4+2],A=Math.max(p,g,v),y=Math.min(p,g,v),M=.15+(A-y)/255,_=p>>3<<10|g>>3<<5|v>>3;n[_]+=M,s[_*3]+=p*M,s[_*3+1]+=g*M,s[_*3+2]+=v*M,c+=1}let l=[],u=[];for(let d=0;d<o;d++){let p=-1,g=0;for(let _=0;_<32768;_++)n[_]>g&&(g=n[_],p=_);if(p<0)break;let v=n[p];l.push([s[p*3]/v/255,s[p*3+1]/v/255,s[p*3+2]/v/255]),u.push(v);let A=p>>10,y=p>>5&31,b=p&31,M=5;for(let _=Math.max(0,A-M);_<=Math.min(31,A+M);_++)for(let w=Math.max(0,y-M);w<=Math.min(31,y+M);w++)for(let x=Math.max(0,b-M);x<=Math.min(31,b+M);x++)n[_<<10|w<<5|x]=0}return{colors:l,weights:u,sampled:c}}a(vn,"extractDominantColors");var Jt=512,Dt=Object.freeze((()=>{let e=[-.42,1,.38],t=Math.hypot(e[0],e[1],e[2]);return e.map(o=>o/t)})());var Qt=.32;var na="background-select",En=2,_n=Object.freeze({grid:Object.freeze({kind:"grid",mode:"grid",opacity:.85,spacing:.2,lineWidth:.01,size:En,lineColor:Object.freeze([.56,.56,.57]),surfaceColor:Object.freeze([.965,.965,.97]),axisColors:Object.freeze({x:Object.freeze([.48,.46,.46]),y:Object.freeze([.46,.48,.46]),z:Object.freeze([.46,.46,.48])})}),"grid-dark":Object.freeze({kind:"grid",mode:"grid-dark",opacity:.75,spacing:.2,lineWidth:.008,size:En,lineColor:Object.freeze([.38,.38,.42]),surfaceColor:Object.freeze([.08,.09,.1]),axisColors:Object.freeze({x:Object.freeze([.62,.58,.58]),y:Object.freeze([.58,.62,.58]),z:Object.freeze([.58,.58,.62])})}),...Object.fromEntries(yn.map(e=>[e,Object.freeze({kind:"studio",mode:e,palette:Zo[e],surfaceColor:Object.freeze(qt(Zo[e].surface))})])),...Object.fromEntries(bn.map(e=>[e,Object.freeze({kind:"look",mode:e,surfaceColor:Object.freeze(wn(e))})]))});function Mn(e){if(e===null||typeof e!="object"||typeof e.getElementById!="function")return null;let t=e.getElementById(na);return t===null||typeof t!="object"||typeof t.value!="string"?null:xn(t.value)?t.value:null}a(Mn,"readActiveViewerBackground");function ia(e){return e===null?null:_n[e]??null}a(ia,"readReferenceGridAppearance");function tc(e){return ia(Mn(e))}a(tc,"readActiveReferenceGridAppearance");function An(e,t){if(e===null)return null;if(!Object.values(_n).includes(e))throw new TypeError(`${t} must be null or a published viewer reference-layer appearance.`);return e}a(An,"assertReferenceGridAppearance");function oc(e){return Mn(e)!==null?[]:[{title:"Active viewer background unavailable",detail:"The background control could not be read, so whether the viewer is drawing a reference layer — and which one, in which theme — cannot be confirmed. Reload the page and export again."}]}a(oc,"buildViewerBackgroundFidelityWarnings");var aa=new Set(["png","svg"]),sa=new Set(["full-vector","optimized-vector","hybrid"]),la=new Set(["right","bottom"]),ca=new Set(["viewer","white","transparent","custom"]),fa=new Set(Ur),rr=Object.freeze(["axisLabelFontSizePx","background","backgroundColor","centroidLabelFontSizePx","crop","depthSort3d","emphasizeSelection","exportAllViews","fontFamily","fontSizePx","height","includeAxes","includeLegend","legendFontSizePx","legendPosition","optimizedTargetCount","referenceGrid","selectionMutedOpacity","showOrientation","signal","strategy","tickFontSizePx","title","titleFontSizePx","width","xLabel","yLabel"]),ua=Object.freeze([...rr,"dpi","format"].sort()),da=Object.freeze([...rr,"jobs"].sort()),ha=Object.freeze(["dpi","format"]),pa=Object.freeze(["dpi","format","gridColumns","height","meta","options","selection","title","views","width"]),Sn=Object.freeze(rr.filter(e=>e!=="exportAllViews"&&e!=="signal").sort()),ma=Object.freeze(["cameraState","data","id","label","name","renderState","scientificState"]),ya=Object.freeze(["centroidColors","centroidFlags","centroidLabelTexts","centroidPositions","colors","pointCount","positions","transparency","vectorField"]),ba=Object.freeze(["colormapId","label","maxMagnitude","unitsPerRender","vectors"]),xa=Object.freeze(["labels","points"]),ga=Object.freeze(["highlightArray","pageName","totalCount","visibleCount"]),wa=Object.freeze(["datasetGeneration","dimensionLevel","drawOrder","fieldKey","fieldKind","filters","geometryGeneration","legendModel","lodMembership","lodSizeMultiplier","normTransform","pointLayers"]),va=Object.freeze(["fieldKey","fieldKind","filters","id","label","name","vectorField"]),Ea=Object.freeze(["center","scale"]),_a=Object.freeze(["antialias","backdrop","bgColor","cameraDistance","cameraPosition","far","fogColor","fogDensity","fogFar","fogNear","fov","lightDir","lightingStrength","modelMatrix","mvpMatrix","near","pointSize","pointSizeMax","projectionMatrix","shaderQuality","sizeAttenuation","viewMatrix","viewportHeight","viewportWidth"]),Ma=Object.freeze(["centerY","extentX","extentY","extentZ","flat","floorY","glowCenterX","look","pixelRatio","planarity","stageX","stageZ"]),Aa=Object.freeze(["ambient","id","shadow","time","tints"]),Ta=Object.freeze(["packed","size","window"]);function Sa(e,t){if(e!==null){if(We(e,Aa,t),!Nt(e.id))throw new TypeError(`${t}.id must name a background look.`);if(!Array.isArray(e.tints)||e.tints.length!==3)throw new TypeError(`${t}.tints must be three colors.`);if(e.tints.forEach((o,r)=>{if(!Array.isArray(o)||o.length!==3)throw new TypeError(`${t}.tints[${r}] must be an RGB triple.`);o.forEach((i,n)=>Je(i,`${t}.tints[${r}][${n}]`,0))}),Je(e.time,`${t}.time`,0),e.ambient!==0&&e.ambient!==1)throw new TypeError(`${t}.ambient must be exactly 0 or 1.`);if(e.shadow!==null){if(We(e.shadow,Ta,`${t}.shadow`),!Number.isSafeInteger(e.shadow.size)||e.shadow.size<=0)throw new TypeError(`${t}.shadow.size must be a positive integer.`);if(!(e.shadow.packed instanceof Uint16Array)||e.shadow.packed.length!==e.shadow.size*e.shadow.size*2)throw new TypeError(`${t}.shadow.packed must be the size² × 2 half-float map.`);if(!Array.isArray(e.shadow.window)||e.shadow.window.length!==3)throw new TypeError(`${t}.shadow.window must be [center u, center v, half size].`);e.shadow.window.forEach((o,r)=>Je(o,`${t}.shadow.window[${r}]`))}}}a(Sa,"assertBackdropLook");function vt(e,t,{allowEmpty:o=!0}={}){if(typeof e!="string"||!o&&e.trim().length===0)throw new TypeError(`${t} must be ${o?"a string":"a non-empty string"}.`)}a(vt,"assertString");function wt(e,t){if(typeof e!="boolean")throw new TypeError(`${t} must be an exact boolean.`)}a(wt,"assertBoolean");function Tn(e){return e===null?!1:Zt(e,"Figure export signal").aborted}a(Tn,"isFigureExportSignalAborted");function ka(e){if(e!==null&&Zt(e,"Figure export signal").aborted)throw jo(e)}a(ka,"throwIfFigureExportAborted");function mc(e,t){return e===null?Promise.resolve(t):(Zt(e,"Figure export signal"),ka(e),new Promise((o,r)=>{let i=!1,n=a(()=>{},"stopListening"),s=a((c,l)=>{i||(i=!0,n(),c(l))},"settle"),f=a(()=>s(r,jo(e)),"settleAborted");n=jr(e,f),Promise.resolve(t).then(c=>{Tn(e)?f():s(o,c)},c=>{Tn(e)?f():s(r,c)})}))}a(mc,"awaitFigureExportAbortable");function He(e,t,o,r=1/0){if(!Number.isSafeInteger(e)||e<o||e>r)throw new RangeError(`${t} must be a safe integer from ${o} through ${r}.`)}a(He,"assertInteger");function Je(e,t,o=-1/0,r=1/0){if(typeof e!="number"||!Number.isFinite(e)||e<o||e>r)throw new RangeError(`${t} must be a finite number from ${o} through ${r}.`)}a(Je,"assertFiniteNumber");function _o(e,t){if(!aa.has(e))throw new TypeError(`${t} must be exactly "svg" or "png".`)}a(_o,"assertFormat");function kn(e,t){He(e.width,`${t}.width`,10),e.height!==null&&He(e.height,`${t}.height`,10)}a(kn,"assertFigureSize");function Rn(e,t){if(kn(e,t),wt(e.exportAllViews,`${t}.exportAllViews`),vt(e.title,`${t}.title`),wt(e.includeAxes,`${t}.includeAxes`),wt(e.includeLegend,`${t}.includeLegend`),!la.has(e.legendPosition))throw new TypeError(`${t}.legendPosition must be "right" or "bottom".`);if(vt(e.xLabel,`${t}.xLabel`),vt(e.yLabel,`${t}.yLabel`),!ca.has(e.background))throw new TypeError(`${t}.background is not a current export background.`);if(typeof e.backgroundColor!="string"||!Xr(e.backgroundColor))throw new TypeError(`${t}.backgroundColor must be an exact #RRGGBB color.`);vt(e.fontFamily,`${t}.fontFamily`,{allowEmpty:!1});for(let o of["fontSizePx","legendFontSizePx","tickFontSizePx","axisLabelFontSizePx","titleFontSizePx","centroidLabelFontSizePx"])Je(e[o],`${t}.${o}`,Number.MIN_VALUE);return Hr(e.crop),An(e.referenceGrid,`${t}.referenceGrid`),wt(e.showOrientation,`${t}.showOrientation`),wt(e.depthSort3d,`${t}.depthSort3d`),wt(e.emphasizeSelection,`${t}.emphasizeSelection`),Je(e.selectionMutedOpacity,`${t}.selectionMutedOpacity`,0,1),e}a(Rn,"assertBaseRequestValues");function $n(e,t,o){return We(e,t,o),Zt(e.signal,`${o}.signal`),Rn(e,o)}a($n,"assertBaseRequest");function nr(e,t,o){if(!t){if(e.strategy!==null)throw new TypeError(`${o}.strategy must be null for PNG-only export.`);if(e.optimizedTargetCount!==null)throw new TypeError(`${o}.optimizedTargetCount must be null for PNG-only export.`);return}if(!sa.has(e.strategy))throw new TypeError(`${o}.strategy must be one explicit current SVG export strategy.`);if(e.strategy==="optimized-vector"){He(e.optimizedTargetCount,`${o}.optimizedTargetCount`,1e3,5e6);return}if(e.optimizedTargetCount!==null)throw new TypeError(`${o}.optimizedTargetCount must be null unless strategy is "optimized-vector".`)}a(nr,"assertStrategyContract");function Ra(e,t){if(We(e,ha,t),_o(e.format,`${t}.format`),e.format==="png")He(e.dpi,`${t}.dpi`,72);else if(e.dpi!==null)throw new TypeError(`${t}.dpi must be null for SVG export.`)}a(Ra,"assertJob");function yc(e){if($n(e,ua,"Figure export request"),_o(e.format,"Figure export request.format"),e.format==="png")He(e.dpi,"Figure export request.dpi",72);else if(e.dpi!==null)throw new TypeError("Figure export request.dpi must be null for SVG export.");return nr(e,e.format==="svg","Figure export request"),e}a(yc,"assertFigureExportSingleRequest");function bc(e){if($n(e,da,"Figure export batch request"),!Array.isArray(e.jobs)||e.jobs.length===0)throw new TypeError("Figure export batch request.jobs must be a non-empty array.");let t=new Set;return e.jobs.forEach((o,r)=>{Ra(o,`Figure export batch request.jobs[${r}]`);let i=o.format==="png"?`png:${o.dpi}`:"svg";if(t.has(i))throw new Error(`Duplicate figure export job "${i}".`);t.add(i)}),nr(e,e.jobs.some(o=>o.format==="svg"),"Figure export batch request"),e}a(bc,"assertFigureExportBatchRequest");function $a(e,t="Figure export view id"){return vt(e,t,{allowEmpty:!1}),e}a($a,"assertFigureExportViewId");function tr(e,t,o,{checkValues:r=!0}={}){if(!(e instanceof Float32Array)||e.length!==t)throw new TypeError(`${o} must be a Float32Array of length ${t}.`);if(r){for(let i of e)if(!Number.isFinite(i))throw new TypeError(`${o} must contain only finite numbers.`)}}a(tr,"assertFloat32Array");function Eo(e,t,o){if(!(e instanceof Uint8Array)||e.length!==t)throw new TypeError(`${o} must be a Uint8Array of length ${t}.`)}a(Eo,"assertUint8Array");function or(e,t,o=new Set){if(!(e===null||typeof e=="string"||typeof e=="boolean")){if(typeof e=="number"){Je(e,t);return}if(typeof e!="object"||o.has(e))throw new TypeError(`${t} must contain only acyclic, owned legend data.`);if(!(e instanceof Uint8Array)){if(o.add(e),Array.isArray(e)){let r=Reflect.ownKeys(e);if(r.length!==e.length+1||!r.includes("length"))throw new TypeError(`${t} must be one dense array without custom properties.`);for(let i=0;i<e.length;i++){if(!Object.hasOwn(e,i))throw new TypeError(`${t} must not contain sparse entries.`);or(e[i],`${t}[${i}]`,o)}o.delete(e);return}xo(e,t);for(let r of Reflect.ownKeys(e)){let i=Object.getOwnPropertyDescriptor(e,r);if(typeof r!="string"||i===void 0||i.enumerable!==!0||!Object.hasOwn(i,"value"))throw new TypeError(`${t} must contain only enumerable string data properties.`);or(i.value,`${t}.${r}`,o)}o.delete(e)}}}a(or,"assertOwnedLegendValue");function Fa(e,t){if(We(e,Ma,t),typeof e.flat!="boolean")throw new TypeError(`${t}.flat must be an exact boolean.`);for(let o of["centerY","floorY","stageX","stageZ"])Je(e[o],`${t}.${o}`);for(let o of["extentX","extentY","extentZ"])Je(e[o],`${t}.${o}`,0);if(Je(e.glowCenterX,`${t}.glowCenterX`,-1,1),Je(e.pixelRatio,`${t}.pixelRatio`,Number.MIN_VALUE),e.planarity!==0&&e.planarity!==1)throw new TypeError(`${t}.planarity must be exactly 0 or 1.`);Sa(e.look,`${t}.look`)}a(Fa,"assertBackdrop");function Oa(e,t){We(e,_a,t),Fa(e.backdrop,`${t}.backdrop`);for(let o of["mvpMatrix","viewMatrix","modelMatrix","projectionMatrix"])tr(e[o],16,`${t}.${o}`);for(let o of["fogColor","bgColor","lightDir"])tr(e[o],3,`${t}.${o}`);if(!Array.isArray(e.cameraPosition)||e.cameraPosition.length!==3)throw new TypeError(`${t}.cameraPosition must be a three-number array.`);if(e.cameraPosition.forEach((o,r)=>{Je(o,`${t}.cameraPosition[${r}]`)}),!(e.pointSizeMax>0)||!Number.isFinite(e.pointSizeMax))throw new RangeError(`${t}.pointSizeMax must be a finite positive number.`);for(let o of["pointSize","sizeAttenuation","fov","near","far","lightingStrength","fogDensity","fogNear","fogFar","cameraDistance"])Je(e[o],`${t}.${o}`);if(He(e.viewportWidth,`${t}.viewportWidth`,1),He(e.viewportHeight,`${t}.viewportHeight`,1),typeof e.antialias!="boolean")throw new TypeError(`${t}.antialias must be an exact boolean.`);if(!fa.has(e.shaderQuality))throw new TypeError(`${t}.shaderQuality is not a current shader quality.`);if(e.fogNear<0||e.fogFar<e.fogNear)throw new RangeError(`${t} fog range must satisfy 0 <= fogNear <= fogFar.`)}a(Oa,"assertRenderState");function za(e,t,o){We(e,ya,o),He(e.pointCount,`${o}.pointCount`,0),He(t,`${o} dimensionLevel`,1,3),tr(e.positions,e.pointCount*t,`${o}.positions`,{checkValues:!1}),Eo(e.colors,e.pointCount*4,`${o}.colors`),Eo(e.transparency,e.pointCount,`${o}.transparency`),We(e.centroidFlags,xa,`${o}.centroidFlags`),wt(e.centroidFlags.points,`${o}.centroidFlags.points`),wt(e.centroidFlags.labels,`${o}.centroidFlags.labels`);let r=[e.centroidPositions,e.centroidColors].map(n=>n!==null);if(r[0]!==r[1])throw new TypeError(`${o} centroid positions and colors must both be present or both be null.`);let i=0;if(r[0]){if(!(e.centroidPositions instanceof Float32Array)||e.centroidPositions.length%3!==0)throw new TypeError(`${o}.centroidPositions must contain xyz triplets.`);i=e.centroidPositions.length/3,Eo(e.centroidColors,i*4,`${o}.centroidColors`)}if(!Array.isArray(e.centroidLabelTexts)||e.centroidLabelTexts.some(n=>typeof n!="string"))throw new TypeError(`${o}.centroidLabelTexts must be an array of strings.`);if(e.centroidFlags.labels&&e.centroidLabelTexts.length!==i)throw new Error(`${o}.centroidLabelTexts must match the published centroid count when labels are enabled.`);if(e.vectorField!==null){let n=e.vectorField;if(We(n,ba,`${o}.vectorField`),typeof n.label!="string"||n.label.length===0||typeof n.colormapId!="string"||n.colormapId.length===0)throw new TypeError(`${o}.vectorField must name its field and color scheme.`);if(!(n.vectors instanceof Float32Array)||n.vectors.length!==e.pointCount*t)throw new TypeError(`${o}.vectorField.vectors must hold one vector per point.`);for(let s of["maxMagnitude","unitsPerRender"])if(!Number.isFinite(n[s])||n[s]<0||s==="unitsPerRender"&&n[s]===0)throw new RangeError(`${o}.vectorField.${s} must be a finite ${s==="unitsPerRender"?"positive":"non-negative"} number.`)}}a(za,"assertViewData");function Ca(e,t,o){if(We(e,ga,o),He(e.totalCount,`${o}.totalCount`,0,t),He(e.visibleCount,`${o}.visibleCount`,0,e.totalCount),e.totalCount===0){if(e.highlightArray!==null)throw new TypeError(`${o}.highlightArray must be null when no cells are highlighted.`);if(e.pageName!==null)throw new TypeError(`${o}.pageName must be null when no cells are highlighted.`);return}if(typeof e.pageName!="string")throw new TypeError(`${o}.pageName must be the highlight page's name when cells are highlighted.`);Eo(e.highlightArray,t,`${o}.highlightArray`)}a(Ca,"assertSelectionSnapshot");function La(e,t,o){if(We(e,wa,o),He(e.datasetGeneration,`${o}.datasetGeneration`,0),He(e.dimensionLevel,`${o}.dimensionLevel`,1,3),He(e.geometryGeneration,`${o}.geometryGeneration`,1),e.fieldKey!==null&&typeof e.fieldKey!="string")throw new TypeError(`${o}.fieldKey must be a string or null.`);if(e.fieldKind!==null&&typeof e.fieldKind!="string")throw new TypeError(`${o}.fieldKind must be a string or null.`);if(e.fieldKey===null!=(e.fieldKind===null))throw new TypeError(`${o} field key and kind describe one field and must be published together.`);if(!Array.isArray(e.filters)||e.filters.some(r=>typeof r!="string"))throw new TypeError(`${o}.filters must be an array of strings.`);if(e.legendModel!==null&&(xo(e.legendModel,`${o}.legendModel`),or(e.legendModel,`${o}.legendModel`)),qr(e.lodMembership,{pointCount:t.pointCount,dimensionLevel:e.dimensionLevel,label:`${o}.lodMembership`}),Jr(e.drawOrder,{pointCount:t.pointCount,label:`${o}.drawOrder`}),Je(e.lodSizeMultiplier,`${o}.lodSizeMultiplier`,Number.MIN_VALUE),e.pointLayers===null||typeof e.pointLayers!="object"||!(Number.isFinite(e.pointLayers.readScale)&&e.pointLayers.readScale>=1)||typeof e.pointLayers.readEveryLevel!="boolean")throw new TypeError(`${o}.pointLayers must be {readScale >= 1, readEveryLevel}.`);if(We(e.normTransform,Ea,`${o}.normTransform`),!Array.isArray(e.normTransform.center)||e.normTransform.center.length!==3)throw new TypeError(`${o}.normTransform.center must be a three-number array.`);e.normTransform.center.forEach((r,i)=>{Je(r,`${o}.normTransform.center[${i}]`)}),Je(e.normTransform.scale,`${o}.normTransform.scale`,Number.MIN_VALUE)}a(La,"assertScientificState");function Pa(e,t){if(xo(e,"Figure export payload.meta"),!Array.isArray(e.views)||e.views.length!==t.length)throw new TypeError("Figure export payload.meta.views must publish one record per exported view.");e.views.forEach((o,r)=>{let i=`Figure export payload.meta.views[${r}]`;We(o,va,i);let n=t[r];if(o.id!==n.id||o.label!==n.label||o.name!==n.name)throw new Error(`${i} must describe the exported view "${n.id}".`);let s=n.scientificState;if(o.fieldKey!==s.fieldKey||o.fieldKind!==s.fieldKind)throw new Error(`${i} must name the field its view was colored by.`);if(o.vectorField!==(n.data.vectorField===null?null:n.data.vectorField.label))throw new Error(`${i} must name the vector field its view draws.`);if(!Array.isArray(o.filters)||o.filters.length!==s.filters.length||o.filters.some((f,c)=>f!==s.filters[c]))throw new Error(`${i} must publish exactly its view's filters.`)})}a(Pa,"assertMetaProvenance");function Ia(e,t){We(e,Sn,t);let o={...e,exportAllViews:!1};Rn(o,t)}a(Ia,"assertPayloadOptions");function xc(e){if(We(e,pa,"Figure export payload"),_o(e.format,"Figure export payload.format"),kn(e,"Figure export payload"),He(e.gridColumns,"Figure export payload.gridColumns",1),e.format==="png")He(e.dpi,"Figure export payload.dpi",72);else if(e.dpi!==null)throw new TypeError("Figure export payload.dpi must be null for SVG export.");if(vt(e.title,"Figure export payload.title"),Ia(e.options,"Figure export payload.options"),nr(e.options,e.format==="svg","Figure export payload.options"),!Array.isArray(e.views)||e.views.length===0)throw new TypeError("Figure export payload.views must be a non-empty array.");let t=e.views[0]?.data?.pointCount;He(t,"Figure export payload point count",0),Ca(e.selection,t,"Figure export payload.selection");let o=new Set;return e.views.forEach((r,i)=>{let n=`Figure export payload.views[${i}]`;if(We(r,ma,n),$a(r.id,`${n}.id`),vt(r.label,`${n}.label`,{allowEmpty:!1}),r.name!==null&&vt(r.name,`${n}.name`,{allowEmpty:!1}),o.has(r.id))throw new Error(`Figure export payload contains duplicate view "${r.id}".`);if(o.add(r.id),za(r.data,r.scientificState?.dimensionLevel,`${n}.data`),r.data.pointCount!==t)throw new RangeError(`${n}.data.pointCount must match every exported view.`);Oa(r.renderState,`${n}.renderState`),st(r.cameraState,`${n}.cameraState`),La(r.scientificState,r.data,`${n}.scientificState`)}),Pa(e.meta,e.views),e}a(xc,"assertFigureExportPayload");function gc(e,t){_o(t,"Figure export payload format");let o={};for(let r of Sn)o[r]=e[r];return t==="png"&&(o.strategy=null,o.optimizedTargetCount=null),Object.freeze(o)}a(gc,"createFigureExportPayloadOptions");var ir=Object.freeze([.2126,.7152,.0722]),Na=.5,Et=Object.freeze({scheme:"light",text:"#111111",mutedText:"#6b7280",frame:"#e5e7eb",surface:"#ffffff",surfaceInk:"#111111",halo:"#ffffff"}),Da=Object.freeze({scheme:"dark",text:"#f3f4f6",mutedText:"#9ca3af",frame:"#374151",surface:"#111827",surfaceInk:"#f3f4f6",halo:"#111827"});function _c({background:e,backgroundColor:t}){if(e==="transparent")return Et;let o=Lt(t);if(o===null)throw new TypeError("Figure ink requires an exact #RRGGBB background color.");return o[0]*ir[0]+o[1]*ir[1]+o[2]*ir[2]>=Na?Et:Da}a(_c,"resolveFigureInk");function Fn(e,t){let o=[[e,t]];for(;o.length>0;){let[r,i]=o.pop();if(r===i)continue;if(r===null||i===null||typeof r!="object"||typeof i!="object")return!1;let n=r instanceof Uint8Array;if(n!==i instanceof Uint8Array)return!1;if(n){if(r.length!==i.length)return!1;for(let l=0;l<r.length;l++)if(r[l]!==i[l])return!1;continue}let s=Array.isArray(r);if(s!==Array.isArray(i))return!1;if(s){if(r.length!==i.length)return!1;for(let l=0;l<r.length;l++)o.push([r[l],i[l]]);continue}let f=Object.keys(r),c=Object.keys(i);if(f.length!==c.length)return!1;for(let l of f){if(!Object.prototype.hasOwnProperty.call(i,l))return!1;o.push([r[l],i[l]])}}return!0}a(Fn,"areLegendModelsSemanticallyEqual");var Ba=" (hidden)",ar=4;function Ua(e,t,o){let r=[],i="";for(let n of e.split(" ")){let s=i===""?n:`${i} ${n}`;i!==""&&o(s)>t?(r.push(i),i=n):i=s}return i!==""&&r.push(i),r}a(Ua,"noteLines");var sr=1.25;function On(e){let t=Array.isArray(e)?e:[],o=Math.max(1,t.length-1);return t.map((r,i)=>{let n=String(r??"").trim(),s=/^(.*\S)\s+(-?\d+(?:\.\d+)?)%$/.exec(n),f=s===null?i/o:Number(s[2])/100;return{color:s===null?n:s[1],offset:Math.min(1,Math.max(0,f))}}).filter(r=>r.color!=="")}a(On,"colorBarStops");function zn(e){let t=(e?.categories||[]).length,o=e?.visible instanceof Uint8Array?e.visible:null,r=Array.isArray(e?.counts?.available)?e.counts.available:null,i=[];for(let n=0;n<t;n++)r!==null&&!(r[n]>0)||i.push({category:n,hidden:o!==null&&o[n]===0});return i}a(zn,"legendEntries");var et=8,Re=10,pt=6,Ao=.5;function Ga(e){return Math.round(e)}a(Ga,"columnGapPx");var eo=8,Bt=12,lr=6,ja=12,Mo=.3,Xa=.35;function oo(e,t,o){let r=e+t/2;return{swatchY:r-Re/2,baseline:r+o*Xa}}a(oo,"entryPlacement");function to(e){return Math.max(14,Math.round(e*1.2))}a(to,"legendLineHeight");function Ka(e,t){return e?Yr(String(e),t?.values??null):t?.kind==="continuous"?"Color scale":"Legend"}a(Ka,"legendTitle");var Wa=4;function Cn(e){return`rgb(${St(e).sample(.6).map(t=>Math.round(Math.max(0,Math.min(1,t))*255)).join(",")})`}a(Cn,"vectorKeyArrowCss");function Ln(e){let t=St(e);return[0,.25,.5,.75,1].map(o=>({offset:o,color:`rgb(${t.sample(o).map(r=>Math.round(Math.max(0,Math.min(1,r))*255)).join(",")})`}))}a(Ln,"vectorKeyRampStops");function _t({model:e,fieldKey:t,fontPx:o,measureText:r,placement:i,extentPx:n,minWidth:s=0,highlight:f=null,vectorKey:c=null}){if(i!=="beside"&&i!=="below")throw new TypeError("A legend is planned beside or below its plot.");if(e==null&&f===null&&c===null)throw new TypeError("A legend lists a model, the highlighted cells, a vector field's key, or several.");let l=Math.max(1,Number(n)||1),u=Ka(t,e),d=r(u,o,600),p=et+o+eo,g=Math.max(s,i==="below"?l:0),v=f===null?0:Re+pt+r(f.label,o),A=f===null?0:eo+to(o),y=a(D=>f===null?null:{label:f.label,color:f.color,top:D+eo},"highlightAt"),b=Wa*o,M=c===null?0:Math.max(Re*2+pt+r(c.label,o),b+pt+r(c.speed,o)),_=c===null?0:eo+to(o)*2,w=a(D=>c===null?null:{label:c.label,speed:c.speed,colormapId:c.colormapId,top:D+A+eo,rampWidth:b},"vectorAt"),x=A+_,O=a(D=>Math.ceil(Math.max(g,et*2+Math.max(D,v,M),et*2+d)),"boxWidth");if(e?.kind==="category"){let D=e.categories||[],$=zn(e).map(({category:z,hidden:C})=>({category:z,hidden:C,label:`${D[z]===void 0?"":Wr(D[z])}${C?Ba:""}`})),R=$.length,U=0;for(let{label:z}of $){let C=r(z,o);C>U&&(U=C)}let B=to(o),V=Math.ceil(Re+pt+U+Ga(o)),I,j;if(i==="beside")I=Math.max(1,Math.floor((l-p-x-et)/B)),j=Math.ceil(R/I);else{let z=Math.max(1,Math.floor((l-et*2)/V));I=Math.max(1,Math.ceil(R/z)),j=Math.ceil(R/I)}let N=Math.min(R,I);return{kind:"category",title:u,fontPx:o,listTop:p,entries:$,lineHeight:B,columns:j,rowsPerColumn:I,columnWidth:V,highlight:y(p+N*B),vectorKey:w(p+N*B),width:O(j*V),height:Math.ceil(p+N*B+x+et)}}if(e?.kind==="continuous"){let D=e.colorbar?.min??e.stats?.min,$=e.colorbar?.max??e.stats?.max,R=Ct(Number(D)),U=Ct(Number($)),B=Ha(e,D,$),V=a(P=>r(P,o),"measure"),I=0;if(B!==null)for(let P of B.split(" "))I=Math.max(I,V(P));let j=O(Math.max(V(R)+ja+V(U),I)),N=j-et*2,z=B===null?[]:Ua(B,N,V),C=p+Bt+lr,F=z.length===0?C+o:C+o*2+ar+(z.length-1)*o*sr;return{kind:"continuous",title:u,fontPx:o,listTop:p,barWidth:N,minText:R,maxText:U,noteLines:z,highlight:y(F+o*Mo),vectorKey:w(F+o*Mo),width:j,height:Math.ceil(F+o*Mo+x+et)}}let k=et+o*(1+Mo);return{kind:"other",title:u,fontPx:o,listTop:p,highlight:y(k),vectorKey:w(k),width:O(0),height:Math.ceil(k+x+et)}}a(_t,"planLegend");function Pn(e,t,o){let r=t+et,{swatchY:i,baseline:n}=oo(o+e.highlight.top,to(e.fontPx),e.fontPx);return{itemX:r,swatchY:i,labelX:r+Re+pt,baseline:n}}a(Pn,"highlightPlacement");function In(e,t,o){let r=t+et,i=to(e.fontPx),n=oo(o+e.vectorKey.top,i,e.fontPx),s=oo(o+e.vectorKey.top+i,i,e.fontPx),f=n.swatchY+Re/2,c=r+Re*2,l=Re*.45;return{arrow:{x0:r,x1:c,y:f,head:l},labelX:c+pt,labelBaseline:n.baseline,ramp:{x:r,y:s.swatchY,width:e.vectorKey.rampWidth,height:Re},speedX:r+e.vectorKey.rampWidth+pt,speedBaseline:s.baseline}}a(In,"vectorKeyPlacement");function Nn(e,t){if(!t||typeof t!="object")throw new TypeError("A figure legend is drawn from its plan (planLegend).");let o=e?.kind==="category"||e?.kind==="continuous"?e.kind:"other";if(t.kind!==o)throw new TypeError(`A ${o} legend cannot be drawn from a ${t.kind} plan.`);if(o==="category"){let r=zn(e);if(t.entries.length!==r.length||t.entries.some((i,n)=>i.category!==r[n].category||i.hidden!==r[n].hidden))throw new TypeError("A category legend plan must list the entries of its model (legendEntries).")}}a(Nn,"assertPlanOfModel");function Ya(e){return e?.logEnabled===!0||e?.scale==="log"||e?.colorbar?.scale==="log"}a(Ya,"isLogColorScale");function Ha(e,t,o){let r=e?.geneSample??null,i=e?.zeroGray?.drawn===!0,n=r!==null?`${Zr(r)}. ${Vr(i)}`:i?"Gray: 0":null,s=[Va(e,t,o),n].filter(f=>f!==null);return s.length===0?null:s.join(" · ")}a(Ha,"buildColorScaleNote");function Va(e,t,o){if(!Ya(e))return e?.colorbar?.centered===!0?"Color scale centered at 0":null;let r=Number(t),i=Number(o);return Number.isFinite(r)&&Number.isFinite(i)&&r>0&&i>0?`Log10 color scale (midpoint ${Ct(Math.sqrt(r*i))})`:"Log10 color scale"}a(Va,"scaleNote");function Dn(e){let t=null,o=null;for(let r of e){let i=r.scientificState.fieldKey,n=r.scientificState.legendModel;if(i===null||n===null)return null;if(t===null){t=i,o=n;continue}if(t!==i||!Fn(o,n))return null}return t===null||o===null?null:{fieldKey:t,model:o}}a(Dn,"resolveSharedGridLegend");function Ic({legendRect:e,legendPlan:t,model:o,fontFamily:r="Arial, Helvetica, sans-serif",idPrefix:i="legend",backgroundFill:n="#ffffff",ink:s=Et}){let f=s.mutedText,c=s.text,l=s.mutedText;if(!e)return{svg:"",defs:""};Nn(o,t);let{x:u,y:d,width:p,height:g}=e,v=et,A=t.fontPx,y=[],b=[];y.push(`<g font-family="${ce(r)}" font-size="${A}" fill="${s.text}">`);let M=n==="transparent"?"none":n;y.push(`<rect x="${u}" y="${d}" width="${p}" height="${g}" fill="${ce(M)}" stroke="${s.frame}" stroke-width="1"/>`),y.push(`<text x="${u+v}" y="${d+v+A}" font-weight="600">${ce(t.title)}</text>`);let _=d+t.listTop;if(t.kind==="category"){let{entries:w,rowsPerColumn:x,columnWidth:O,lineHeight:k}=t,D=o.colors;for(let $=0;$<w.length;$++){let R=Math.floor($/x),U=$%x,B=u+v+R*O,{swatchY:V,baseline:I}=oo(_+U*k,k,A),j=B+Re+pt,{category:N,hidden:z,label:C}=w[$];z?y.push(`<rect x="${B}" y="${V}" width="${Re}" height="${Re}" fill="none" stroke="${f}" stroke-width="1"/>`):y.push(`<rect x="${B}" y="${V}" width="${Re}" height="${Re}" fill="${Xo(D,N)}" stroke="${c}" stroke-width="${Ao}"/>`),y.push(`<text x="${j}" y="${I}" fill="${z?f:c}">${ce(C)}</text>`)}}else if(t.kind==="continuous"){let w=`${i}_grad`,x=On(o.colorStops);b.push(`<linearGradient id="${w}" x1="0" x2="1" y1="0" y2="0">`);for(let $ of x)b.push(`<stop offset="${+($.offset*100).toFixed(3)}%" stop-color="${$.color}"/>`);b.push("</linearGradient>");let O=t.barWidth;y.push(`<rect x="${u+v}" y="${_}" width="${O}" height="${Bt}" fill="url(#${w})" stroke="${s.text}" stroke-width="0.5"/>`);let k=_+Bt+lr;y.push(`<text x="${u+v}" y="${k+A}" fill="${l}">${ce(t.minText)}</text>`),y.push(`<text x="${u+v+O}" y="${k+A}" text-anchor="end" fill="${l}">${ce(t.maxText)}</text>`);let D=k+A*2+ar;t.noteLines.forEach(($,R)=>{y.push(`<text x="${u+v}" y="${D+R*A*sr}" fill="${l}">${ce($)}</text>`)})}if(t.highlight!==null){let{itemX:w,swatchY:x,labelX:O,baseline:k}=Pn(t,u,d);y.push(`<rect x="${w}" y="${x}" width="${Re}" height="${Re}" fill="${ce(t.highlight.color)}" stroke="${c}" stroke-width="${Ao}"/>`),y.push(`<text x="${O}" y="${k}" fill="${c}">${ce(t.highlight.label)}</text>`)}if(t.vectorKey){let w=In(t,u,d),x=Cn(t.vectorKey.colormapId),O=`${i}-vector-ramp`;b.push(`<linearGradient id="${ce(O)}">${Ln(t.vectorKey.colormapId).map(U=>`<stop offset="${U.offset}" stop-color="${U.color}"/>`).join("")}</linearGradient>`);let{x0:k,x1:D,y:$,head:R}=w.arrow;y.push(`<path d="M${k} ${$}L${D-R} ${$}" stroke="${x}" stroke-width="${Math.max(1,A*.12)}"/>`),y.push(`<polygon points="${D} ${$} ${D-R} ${$-R*.6} ${D-R} ${$+R*.6}" fill="${x}"/>`),y.push(`<text x="${w.labelX}" y="${w.labelBaseline}" fill="${c}">${ce(t.vectorKey.label)}</text>`),y.push(`<rect x="${w.ramp.x}" y="${w.ramp.y}" width="${w.ramp.width}" height="${w.ramp.height}" fill="url(#${ce(O)})"/>`),y.push(`<text x="${w.speedX}" y="${w.speedBaseline}" fill="${c}">${ce(t.vectorKey.speed)}</text>`)}return y.push("</g>"),{svg:y.join(""),defs:b.length?`<defs>${b.join("")}</defs>`:""}}a(Ic,"renderSvgLegend");function Nc({ctx:e,legendRect:t,legendPlan:o,model:r,fontFamily:i="Arial, Helvetica, sans-serif",backgroundFill:n="#ffffff",ink:s=Et}){let f=s.mutedText,c=s.text,l=s.mutedText;if(!e||!t)return;Nn(r,o);let{x:u,y:d,width:p,height:g}=t,v=et,A=o.fontPx;e.save(),n!=="transparent"&&(e.fillStyle=n,e.fillRect(u,d,p,g)),e.strokeStyle=s.frame,e.lineWidth=1,e.strokeRect(u,d,p,g),e.fillStyle=s.text,e.font=`600 ${A}px ${i}`,e.textAlign="left",e.textBaseline="alphabetic",e.fillText(o.title,u+v,d+v+A);let y=d+o.listTop;if(e.font=`${A}px ${i}`,o.kind==="category"){let{entries:b,rowsPerColumn:M,columnWidth:_,lineHeight:w}=o,x=r.colors;for(let O=0;O<b.length;O++){let k=Math.floor(O/M),D=O%M,$=u+v+k*_,{swatchY:R,baseline:U}=oo(y+D*w,w,A),B=$+Re+pt,{category:V,hidden:I,label:j}=b[O];I?(e.strokeStyle=f,e.lineWidth=1,e.strokeRect($,R,Re,Re)):(e.fillStyle=Xo(x,V),e.fillRect($,R,Re,Re),e.strokeStyle=c,e.lineWidth=Ao,e.strokeRect($,R,Re,Re)),e.fillStyle=I?f:c,e.fillText(j,B,U)}}else if(o.kind==="continuous"){let b=o.barWidth,M=e.createLinearGradient(u+v,0,u+v+b,0);for(let w of On(r.colorStops))M.addColorStop(w.offset,w.color);e.fillStyle=M,e.fillRect(u+v,y,b,Bt),e.strokeStyle=s.text,e.lineWidth=.5,e.strokeRect(u+v,y,b,Bt);let _=y+Bt+lr;e.fillStyle=l,e.textAlign="left",e.fillText(o.minText,u+v,_+A),e.textAlign="right",e.fillText(o.maxText,u+v+b,_+A),e.textAlign="left",o.noteLines.forEach((w,x)=>{e.fillText(w,u+v,_+A*2+ar+x*A*sr)})}if(o.highlight!==null){let{itemX:b,swatchY:M,labelX:_,baseline:w}=Pn(o,u,d);e.fillStyle=o.highlight.color,e.fillRect(b,M,Re,Re),e.strokeStyle=c,e.lineWidth=Ao,e.strokeRect(b,M,Re,Re),e.fillStyle=c,e.textAlign="left",e.fillText(o.highlight.label,_,w)}if(o.vectorKey){let b=In(o,u,d),M=Cn(o.vectorKey.colormapId),{x0:_,x1:w,y:x,head:O}=b.arrow;e.strokeStyle=M,e.fillStyle=M,e.lineWidth=Math.max(1,A*.12),e.beginPath(),e.moveTo(_,x),e.lineTo(w-O,x),e.stroke(),e.beginPath(),e.moveTo(w,x),e.lineTo(w-O,x-O*.6),e.lineTo(w-O,x+O*.6),e.closePath(),e.fill();let k=e.createLinearGradient(b.ramp.x,0,b.ramp.x+b.ramp.width,0);for(let D of Ln(o.vectorKey.colormapId))k.addColorStop(D.offset,D.color);e.fillStyle=k,e.fillRect(b.ramp.x,b.ramp.y,b.ramp.width,b.ramp.height),e.fillStyle=c,e.textAlign="left",e.fillText(o.vectorKey.label,b.labelX,b.labelBaseline),e.fillText(o.vectorKey.speed,b.speedX,b.speedBaseline)}e.restore()}a(Nc,"drawCanvasLegend");function ot(e,t){let[o,r,i]=t;return{x:e[0]*o+e[4]*r+e[8]*i+e[12],y:e[1]*o+e[5]*r+e[9]*i+e[13],z:e[2]*o+e[6]*r+e[10]*i+e[14],w:e[3]*o+e[7]*r+e[11]*i+e[15]}}a(ot,"toClipSpace");function To(e,t){let o=0,r=1,i=[[e.z+e.w,t.z+t.w],[e.w-e.z,t.w-t.z]];for(let[n,s]of i){if(n<0&&s<0)return null;if(n===s)continue;let f=n/(n-s);n<0?f>o&&(o=f):s<0&&f<r&&(r=f)}return r>o?[o,r]:null}a(To,"clipSegmentDepthRange");function Mt(e,t,o){return[e[0]+(t[0]-e[0])*o,e[1]+(t[1]-e[1])*o,e[2]+(t[2]-e[2])*o]}a(Mt,"lerpPoint");function So({renderState:e,plotRect:t,crop:o=null}){let{source:r,scale:i,viewportToPlot:n}=Pt({renderState:e,plotRect:t,crop:o}),s=r.viewportWidth,f=r.viewportHeight,c=a(u=>u.w>1e-9?{x:(u.x/u.w*.5+.5)*s,y:(-u.y/u.w*.5+.5)*f}:null,"clipToViewport"),l=a(u=>{let d=c(u);return d===null?null:n(d.x,d.y)},"toPlot");return{viewportW:s,viewportH:f,srcX0:r.x,srcY0:r.y,srcW:r.width,srcH:r.height,scale:i,viewportToPlot:n,clipToViewport:c,toPlot:l}}a(So,"createPlotProjection");function ko(e){let t=e[0],o=e[1],r=e[2],i=e[3],n=e[4],s=e[5],f=e[6],c=e[7],l=e[8],u=e[9],d=e[10],p=e[11],g=e[12],v=e[13],A=e[14],y=e[15],b=t*s-o*n,M=t*f-r*n,_=t*c-i*n,w=o*f-r*s,x=o*c-i*s,O=r*c-i*f,k=l*v-u*g,D=l*A-d*g,$=l*y-p*g,R=u*A-d*v,U=u*y-p*v,B=d*y-p*A,V=b*B-M*U+_*R+w*$-x*D+O*k;if(!Number.isFinite(V)||V===0)return null;let I=1/V;return[(s*B-f*U+c*R)*I,(r*U-o*B-i*R)*I,(v*O-A*x+y*w)*I,(d*x-u*O-p*w)*I,(f*$-n*B-c*D)*I,(t*B-r*$+i*D)*I,(A*_-g*O-y*M)*I,(l*O-d*_+p*M)*I,(n*U-s*$+c*k)*I,(o*$-t*U-i*k)*I,(g*x-v*_+y*b)*I,(u*_-l*x-p*b)*I,(s*D-n*R-f*k)*I,(t*R-o*D+r*k)*I,(v*M-g*w-A*b)*I,(l*w-u*M+d*b)*I]}a(ko,"invertMatrix4");function Bn(e,t,o,r){let i=e[0]*t+e[4]*o+e[8]*r+e[12],n=e[1]*t+e[5]*o+e[9]*r+e[13],s=e[2]*t+e[6]*o+e[10]*r+e[14],f=e[3]*t+e[7]*o+e[11]*r+e[15];return Math.abs(f)>1e-12?[i/f,n/f,s/f]:null}a(Bn,"unproject");function Za(e,t,o,r,i){let n=Bn(e,o,r,-1),s=Bn(e,o,r,1);if(n===null||s===null)return null;let f=s[2]-n[2];if(f===0)return null;let c=(i-n[2])/f;if(!Number.isFinite(c))return null;let l=[n[0]+(s[0]-n[0])*c,n[1]+(s[1]-n[1])*c,i];return t[3]*l[0]+t[7]*l[1]+t[11]*l[2]+t[15]>0?l:null}a(Za,"rayOnPlane");function Xn({dimension:e,navigationMode:t}){return e<=2&&t==="planar"}a(Xn,"figureViewHasAxes");function Kn(e,t){return e.map(o=>t===!0&&Xn({dimension:o.scientificState.dimensionLevel,navigationMode:o.cameraState.navigationMode}))}a(Kn,"figurePanelAxes");function Wn({renderState:e,crop:t=null,dimension:o,cameraState:r,normTransform:i}){let n=en({renderState:e,crop:t}),s=st(r,"Figure axis camera state"),f=2*n.x/n.viewportWidth-1,c=2*(n.x+n.width)/n.viewportWidth-1,l=1-2*n.y/n.viewportHeight,u=1-2*(n.y+n.height)/n.viewportHeight,d=[[f,u],[c,u],[f,l],[c,l]];if(!Xn({dimension:o,navigationMode:s.navigationMode}))throw new RangeError("Only a 1-D or 2-D view seen planar has axes (figureViewHasAxes).");let p=e.mvpMatrix,g=ko(p);if(g===null)return null;let v=a((_,w)=>{let x=Za(g,p,_,w,0);return x===null?null:nn(x[0],x[1],i)},"toAxes"),A=1/0,y=-1/0,b=1/0,M=-1/0;for(let[_,w]of d){let x=v(_,w);if(x===null||!Number.isFinite(x.x)||!Number.isFinite(x.y))return null;x.x<A&&(A=x.x),x.x>y&&(y=x.x),x.y<b&&(b=x.y),x.y>M&&(M=x.y)}return!(y>A)||!(M>b)?null:{minX:A,maxX:y,minY:b,maxY:M}}a(Wn,"computeSourceAxisBounds");function qa({ticks:e,step:t}){let o=0;for(let i of e)o=Math.max(o,Math.abs(i));let r=Nr(o,t);return e.map(i=>Ct(i,r))}a(qa,"tickLabels");var Ja=5,Qa=.5,es=[1,2,2.5,4,5];function ts(e){let t=Math.floor(Math.log10(e)),o=+`1e${t}`,r=e/o;for(let i of es)if(i>r*(1+1e-9))return i*o;return+`1e${t+1}`}a(ts,"nextNiceStep");function os(e,t,o){if(!Number.isFinite(e)||!Number.isFinite(t)||!(t>e))throw new RangeError("Figure axis bounds must be finite with max above min.");if(!(o>0)||!Number.isFinite(o))throw new RangeError("Figure axis step must be a finite positive number.");let r=t-e,i=r*1e-9,n=[];for(let s=Math.ceil((e-i)/o);s*o<=t+i;s++)n.push(+(s*o).toFixed(12));return{labels:qa({ticks:n,step:o}),fractions:n.map(s=>Math.min(1,Math.max(0,(s-e)/r)))}}a(os,"axisTicksAtStep");function Un({min:e,max:t,lengthPx:o,direction:r,fontPx:i,measureText:n}){if(!(o>0)||!Number.isFinite(o))throw new RangeError("Figure axis length must be a finite positive number.");if(r!=="x"&&r!=="y")throw new TypeError('Figure axis direction must be "x" or "y".');let s=Math.max(4,i*Qa),f=a(d=>r==="x"?n(d,i):i,"extentOf"),c=a(d=>{let p=d.labels.map(f);for(let g=1;g<d.fractions.length;g++)if((d.fractions[g]-d.fractions[g-1])*o<(p[g-1]+p[g])/2+s)return!1;return!0},"fits"),l=Qr(e,t,Ja).step,u=null;for(;;){let d=os(e,t,l);if(d.labels.length>=2&&c(d))return d;if(d.labels.length===1&&u===null&&(u=d),l>=t-e)return u??d;l=ts(l)}}a(Un,"planAxisTicks");var Gn=6,Ut=5,ro=.8,Rt=.3,rs=.35,ns=.3,is=.4,as=4;function jn(e,t){if(!(Number.isFinite(e)&&e>0))throw new RangeError(`Figure axes are drawn with a positive ${t} font size, not ${e}.`);return Math.max(6,Math.round(e))}a(jn,"axisFontOf");function cr({bounds:e,plotWidth:t,plotHeight:o,xLabel:r="",yLabel:i="",tickFontPx:n,labelFontPx:s=null,measureText:f}){if(!(t>0)||!(o>0)||!Number.isFinite(t)||!Number.isFinite(o))throw new RangeError("Figure axes are planned for a plot of finite positive size.");let c=jn(n,"tick"),l=s===null?c:jn(s,"axis label"),u=Un({min:e.minX,max:e.maxX,lengthPx:t,direction:"x",fontPx:c,measureText:f}),d=Un({min:e.minY,max:e.maxY,lengthPx:o,direction:"y",fontPx:c,measureText:f}),p=String(r??"").trim(),g=String(i??"").trim(),v=Math.max(3,Math.round(c*ns)),A=Math.max(4,Math.round(l*is)),y=o+Gn,b=-Gn,M=[{x1:0,y1:y,x2:t,y2:y},{x1:b,y1:0,x2:b,y2:o}],_=[],w=b-Ut,x=t,O=0,k=y+Ut,D=a((N,z,C,F)=>{w=Math.min(w,N),x=Math.max(x,z),O=Math.min(O,C),k=Math.max(k,F)},"reach"),$=b-Ut-v,R=$,U=[];d.fractions.forEach((N,z)=>{let C=o-N*o;M.push({x1:b,y1:C,x2:b-Ut,y2:C});let F=C+rs*c,P=$-f(d.labels[z],c);R=Math.min(R,P),_.push({text:d.labels[z],x:$,y:F,anchor:"end",fontPx:c,vertical:!1}),U.push({left:P,bottom:F+Rt*c}),D(P,$,F-ro*c,F+Rt*c)});let B=u.labels.map(N=>f(N,c)/2),V=y+Ut+v;u.fractions.forEach((N,z)=>{let C=N*t-B[z];for(let F of U)C<$&&F.left<N*t+B[z]&&(V=Math.max(V,F.bottom+v))});let I=V+ro*c;if(u.fractions.forEach((N,z)=>{let C=N*t;M.push({x1:C,y1:y,x2:C,y2:y+Ut});let F=B[z];_.push({text:u.labels[z],x:C,y:I,anchor:"middle",fontPx:c,vertical:!1}),D(C-F,C+F,V,I+Rt*c)}),p){let N=I+Rt*c+A+ro*l,z=f(p,l)/2,C=Math.max(t/2,z);_.push({text:p,x:C,y:N,anchor:"middle",fontPx:l,vertical:!1}),D(C-z,C+z,N-ro*l,N+Rt*l)}if(g){let N=R-A-Rt*l,z=f(g,l)/2,C=Math.min(o/2,o-z);_.push({text:g,x:N,y:C,anchor:"middle",fontPx:l,vertical:!0}),D(N-ro*l,N+Rt*l,C-z,C+z)}let j=a(N=>N>0?Math.ceil(N+as):0,"margin");return{plotWidth:t,plotHeight:o,lines:M,texts:_,margins:{left:j(-w),right:j(x-t),top:j(-O),bottom:j(k-o)}}}a(cr,"planFigureAxes");function Yn(e,t){if(Math.abs(t.width-e.plotWidth)>1e-6||Math.abs(t.height-e.plotHeight)>1e-6)throw new RangeError("Figure axes are drawn on the plot they were planned for (planFigureAxes).");let{x:o,y:r}=t;return{lines:e.lines.map(i=>({x1:i.x1+o,y1:i.y1+r,x2:i.x2+o,y2:i.y2+r})),texts:e.texts.map(i=>({...i,x:i.x+o,y:i.y+r}))}}a(Yn,"placeFigureAxes");function qc({plotRect:e,axes:t,fontFamily:o="Arial, Helvetica, sans-serif",color:r="#111"}){let{lines:i,texts:n}=Yn(t,e),s=[`<g font-family="${ce(o)}" fill="${ce(r)}" stroke="${ce(r)}" stroke-width="1">`];for(let f of i)s.push(`<line x1="${f.x1}" y1="${f.y1}" x2="${f.x2}" y2="${f.y2}"/>`);for(let f of n){let c=f.vertical?` transform="rotate(-90 ${f.x} ${f.y})"`:"";s.push(`<text x="${f.x}" y="${f.y}" text-anchor="${f.anchor}" font-size="${f.fontPx}" stroke="none"${c}>${ce(f.text)}</text>`)}return s.push("</g>"),s.join("")}a(qc,"renderSvgAxes");var ss={middle:"center",end:"right"};function Jc({ctx:e,plotRect:t,axes:o,fontFamily:r="Arial, Helvetica, sans-serif",color:i="#111"}){let{lines:n,texts:s}=Yn(o,t);e.save(),e.strokeStyle=i,e.fillStyle=i,e.lineWidth=1,e.textBaseline="alphabetic",e.beginPath();for(let f of n)e.moveTo(f.x1,f.y1),e.lineTo(f.x2,f.y2);e.stroke();for(let f of s)e.font=`${f.fontPx}px ${r}`,e.textAlign=ss[f.anchor],f.vertical?(e.save(),e.translate(f.x,f.y),e.rotate(-Math.PI/2),e.fillText(f.text,0,0),e.restore()):e.fillText(f.text,f.x,f.y);e.restore()}a(Jc,"drawCanvasAxes");function ls(e){if(!Number.isSafeInteger(e)||e<0)throw new RangeError("Figure export panel index must be a non-negative integer.");let t=e,o="";do o=String.fromCharCode(65+t%26)+o,t=Math.floor(t/26)-1;while(t>=0);return o}a(ls,"panelLetter");function Hn(e,t){return`${ls(t)}. ${String(e?.name??(e?.label||String(e?.id||"live")))}`}a(Hn,"panelTitle");var cs=40,fs=.5,us=.01,ds=.5;function Vn({vectorField:e,positions:t,dimension:o,transparency:r,renderState:i,plotRect:n,crop:s=null}){let{label:f,colormapId:c,vectors:l,maxMagnitude:u,unitsPerRender:d}=e,{source:p,viewportToPlot:g}=Pt({renderState:i,plotRect:n,crop:s}),v=i.mvpMatrix,A=g(p.x,p.y),y=n.width/p.width,b=Math.max(n.width,n.height)/cs,M=Math.max(1,Math.round(n.width/b)),_=Math.max(1,Math.round(n.height/b)),w=n.width/M,x=n.height/_,O=fs*Math.min(w,x),k=3*O,D=M*_,$=new Float64Array(D),R=new Float64Array(D*2),U=new Float64Array(D),B=new Float64Array(3),V=new Float64Array(3),I=u>0?.01/u:0,j=0,N=r.length;for(let ee=0;ee<N;ee++){if(r[ee]!==1)continue;let xe=ee*o,$e=0,be=!0;for(let ye=0;ye<o;ye++){let G=l[xe+ye];Number.isFinite(G)||(be=!1),$e+=G*G}if(!be)continue;let T=t[xe],H=o>1?t[xe+1]:0,te=o>2?t[xe+2]:0;if(!rn(v,p,T,H,te,B))continue;let W=l[xe],ae=o>1?l[xe+1]:0,Z=o>2?l[xe+2]:0,ne=0,we=0;if(I>0&&$e>0){if(!ps(v,p,T+W*I,H+ae*I,te+Z*I,V))continue;ne=(V[0]-B[0])*y/I,we=(V[1]-B[1])*y/I}j++;let Se=A.x+B[0]*y-n.x,Oe=A.y+B[1]*y-n.y,me=Math.max(0,Math.ceil((Se-k)/w-.5)),Ee=Math.min(M-1,Math.floor((Se+k)/w-.5)),Le=Math.max(0,Math.ceil((Oe-k)/x-.5)),Pe=Math.min(_-1,Math.floor((Oe+k)/x-.5)),Me=Math.sqrt($e);for(let ye=Le;ye<=Pe;ye++){let G=(ye+.5)*x-Oe;for(let J=me;J<=Ee;J++){let Q=(J+.5)*w-Se,q=Q*Q+G*G;if(q>k*k)continue;let oe=Math.exp(-q/(2*O*O)),ge=ye*M+J;$[ge]+=oe,R[ge*2]+=oe*ne,R[ge*2+1]+=oe*we,U[ge]+=oe*Me}}}let z={arrows:[],step:b,strokeWidth:hs(b),speedMax:u*d,colormapId:c,label:f,cells:j};if(j===0)return z;let C=[...$].filter(ee=>ee>0).sort((ee,xe)=>ee-xe),F=C[Math.min(C.length-1,Math.floor(.99*(C.length-1)))],P=us*F,Y=0,ue=0;for(let ee=0;ee<D;ee++){if(!($[ee]>0)||$[ee]<P)continue;let xe=Math.max(1,$[ee]);Y+=Math.hypot(R[ee*2],R[ee*2+1])/xe,ue++}if(!(Y>0))return z;let ke=ds*Math.min(w,x)/(Y/ue),Ke=St(c),Ue=[];for(let ee=0;ee<D;ee++){if(!($[ee]>0)||$[ee]<P)continue;let xe=Math.max(1,$[ee]),$e=R[ee*2]/xe*ke,be=R[ee*2+1]/xe*ke,T=Math.hypot($e,be);if(!(T>.05*w))continue;let H=n.x+(ee%M+.5)*w,te=n.y+(Math.floor(ee/M)+.5)*x,W=Math.min(1,U[ee]/$[ee]/u),ae=Ke.sample(W).map(Z=>Math.round(Math.max(0,Math.min(1,Z))*255));Ue.push({x0:H-$e/2,y0:te-be/2,x1:H+$e/2,y1:te+be/2,head:Math.min(T*.45,.4*Math.min(w,x)),rgb:ae})}return{...z,arrows:Ue}}a(Vn,"planVectorFieldFigure");function hs(e){return Math.max(.6,e*.07)}a(hs,"strokeWidthOf");function ps(e,t,o,r,i,n){let s=e[3]*o+e[7]*r+e[11]*i+e[15];return!(s>0)||s===1/0?!1:(n[0]=((e[0]*o+e[4]*r+e[8]*i+e[12])/s*.5+.5)*t.viewportWidth-t.x,n[1]=(.5-(e[1]*o+e[5]*r+e[9]*i+e[13])/s*.5)*t.viewportHeight-t.y,!0)}a(ps,"projectUnbounded");function Zn(e){let t=e.x1-e.x0,o=e.y1-e.y0,r=Math.hypot(t,o),i=t/r,n=o/r,s=e.x1-i*e.head,f=e.y1-n*e.head,c=e.head*.5;return[e.x1,e.y1,s-n*c,f+i*c,s+n*c,f-i*c]}a(Zn,"headOf");function qn(e){let t=e.x1-e.x0,o=e.y1-e.y0,r=Math.hypot(t,o);return[e.x1-t/r*e.head*.8,e.y1-o/r*e.head*.8]}a(qn,"shaftEnd");function ms(e){return e===0?"0":e>=100?String(Math.round(e)):String(Number(e.toPrecision(3)))}a(ms,"formatSpeed");function Jn(e){return[`${e.label}: mean arrows of nearby cells`,`speed 0 – ${ms(e.speedMax)}`]}a(Jn,"vectorFieldKeyText");function Qn(e){let[t,o]=Jn({label:e.label,speedMax:e.maxMagnitude*e.unitsPerRender});return{label:t,speed:o,colormapId:e.colormapId}}a(Qn,"vectorFieldLegendKey");var fe=a(e=>e.toFixed(2),"f");function ys(e,{plotRect:t,ink:o,fontFamily:r,fontSizePx:i,haloColor:n,inPlotKey:s}){if(typeof s!="boolean")throw new TypeError("A vector field is drawn with its key in the plot or in the legend (inPlotKey).");let f=['<g class="cellucid-vector-field" stroke-linecap="round" stroke-linejoin="round">'],c=e.strokeWidth;for(let l of e.arrows){let[u,d]=qn(l),p=Zn(l).map(fe).join(" "),g=`rgb(${l.rgb.join(",")})`,v=ce(n);f.push(`<path d="M${fe(l.x0)} ${fe(l.y0)}L${fe(u)} ${fe(d)}" fill="none" stroke="${v}" stroke-width="${fe(c*2.6)}"/><polygon points="${p}" fill="${v}" stroke="${v}" stroke-width="${fe(c*1.6)}"/><path d="M${fe(l.x0)} ${fe(l.y0)}L${fe(u)} ${fe(d)}" fill="none" stroke="${g}" stroke-width="${fe(c)}"/><polygon points="${p}" fill="${g}"/>`)}return f.push("</g>"),s&&f.push(xs(e,{plotRect:t,ink:o,fontFamily:r,fontSizePx:i})),f.join("")}a(ys,"renderSvgVectorField");function bs(e,t,o,r){let i=[];for(let n of e.split(" ")){let s=i.length-1;s>=0&&r(`${i[s]} ${n}`,o)<=t?i[s]=`${i[s]} ${n}`:i.push(n)}return i}a(bs,"wrapWords");function ei(e,{plotRect:t,fontSizePx:o,measure:r}){let[i,n]=Jn(e),s=Math.max(8,o*.85),f=s*.5,c=s*5,l=s*2.2,u=t.width-f*4-l,d=r(i,s)<=u?[i]:bs(i,u,s,r),p=[...d,n],v=Math.max(...d.map(M=>r(M,s)+l),r(n,s)+c+s*.6)+f*2,A=s*(1.4*(p.length-1)+1.2)+f*2,y=Math.max(t.x+f,t.x+t.width-v-f),b=Math.max(t.y+f,t.y+t.height-A-f);return{lines:p,labelLines:d.length,size:s,pad:f,rampWidth:c,x:y,y:b,width:v,height:A}}a(ei,"planVectorFieldKey");function ti(e,t){return e.length*t*.62}a(ti,"estimateTextWidth");function xs(e,{plotRect:t,ink:o,fontFamily:r,fontSizePx:i}){if(e.arrows.length===0)return"";let n=ei(e,{plotRect:t,fontSizePx:i,measure:ti}),s=St(e.colormapId),f=[0,.25,.5,.75,1].map(b=>{let M=s.sample(b).map(_=>Math.round(Math.max(0,Math.min(1,_))*255));return`<stop offset="${b}" stop-color="rgb(${M.join(",")})"/>`}).join(""),c=`cellucid-vector-ramp-${Math.round(n.x)}-${Math.round(n.y)}`,l=n.y+n.pad+n.size,u=a(b=>l+b*n.size*1.4,"lineAt"),d=u(n.labelLines),p=l-n.size*.35,g=s.sample(.6).map(b=>Math.round(Math.max(0,Math.min(1,b))*255)),v=n.x+n.pad,A=v+n.size*1.6,y=n.lines.slice(0,n.labelLines).map((b,M)=>`<text x="${fe(A+n.size*.6)}" y="${fe(u(M))}" fill="${ce(o.surfaceInk)}">${ce(b)}</text>`).join("");return`<g class="cellucid-vector-field-key" font-family="${ce(r)}" font-size="${fe(n.size)}"><defs><linearGradient id="${c}">${f}</linearGradient></defs><rect x="${fe(n.x)}" y="${fe(n.y)}" width="${fe(n.width)}" height="${fe(n.height)}" rx="${fe(n.size*.3)}" fill="${ce(o.surface)}" fill-opacity="0.85" stroke="${ce(o.frame)}"/><path d="M${fe(v)} ${fe(p)}L${fe(A-n.size*.4)} ${fe(p)}" stroke="rgb(${g.join(",")})" stroke-width="${fe(Math.max(1,n.size*.12))}"/><polygon points="${fe(A)} ${fe(p)} ${fe(A-n.size*.55)} ${fe(p-n.size*.3)} ${fe(A-n.size*.55)} ${fe(p+n.size*.3)}" fill="rgb(${g.join(",")})"/>`+y+`<rect x="${fe(v)}" y="${fe(d-n.size*.75)}" width="${fe(n.rampWidth)}" height="${fe(n.size*.7)}" fill="url(#${c})"/><text x="${fe(v+n.rampWidth+n.size*.6)}" y="${fe(d)}" fill="${ce(o.surfaceInk)}">${ce(n.lines[n.labelLines])}</text></g>`}a(xs,"renderSvgKey");function gs(e,t,{plotRect:o,ink:r,fontFamily:i,fontSizePx:n,haloColor:s,inPlotKey:f}){if(typeof f!="boolean")throw new TypeError("A vector field is drawn with its key in the plot or in the legend (inPlotKey).");e.save(),e.lineCap="round",e.lineJoin="round";let c=t.strokeWidth;for(let l of["halo","color"])for(let u of t.arrows){let[d,p]=qn(u),g=Zn(u),v=l==="halo"?s:`rgb(${u.rgb.join(",")})`;e.strokeStyle=v,e.fillStyle=v,e.lineWidth=l==="halo"?c*2.6:c,e.beginPath(),e.moveTo(u.x0,u.y0),e.lineTo(d,p),e.stroke(),e.beginPath(),e.moveTo(g[0],g[1]),e.lineTo(g[2],g[3]),e.lineTo(g[4],g[5]),e.closePath(),e.fill(),l==="halo"&&(e.lineWidth=c*1.6,e.stroke())}if(f&&t.arrows.length>0){let l=ei(t,{plotRect:o,fontSizePx:n,measure:a((_,w)=>(e.font=`${w}px ${i}`,Math.max(e.measureText(_).width,ti(_,w))),"measure")}),u=St(t.colormapId);e.globalAlpha=.85,e.fillStyle=r.surface,e.fillRect(l.x,l.y,l.width,l.height),e.globalAlpha=1,e.strokeStyle=r.frame,e.lineWidth=1,e.strokeRect(l.x,l.y,l.width,l.height);let d=l.y+l.pad+l.size,p=a(_=>d+_*l.size*1.4,"lineAt"),g=p(l.labelLines),v=d-l.size*.35,A=`rgb(${u.sample(.6).map(_=>Math.round(Math.max(0,Math.min(1,_))*255)).join(",")})`,y=l.x+l.pad,b=y+l.size*1.6;e.strokeStyle=A,e.fillStyle=A,e.lineWidth=Math.max(1,l.size*.12),e.beginPath(),e.moveTo(y,v),e.lineTo(b-l.size*.4,v),e.stroke(),e.beginPath(),e.moveTo(b,v),e.lineTo(b-l.size*.55,v-l.size*.3),e.lineTo(b-l.size*.55,v+l.size*.3),e.closePath(),e.fill();let M=e.createLinearGradient(y,0,y+l.rampWidth,0);for(let _ of[0,.25,.5,.75,1])M.addColorStop(_,`rgb(${u.sample(_).map(w=>Math.round(Math.max(0,Math.min(1,w))*255)).join(",")})`);e.fillStyle=M,e.fillRect(y,g-l.size*.75,l.rampWidth,l.size*.7),e.fillStyle=r.surfaceInk,e.font=`${l.size}px ${i}`,e.textBaseline="alphabetic",e.textAlign="left",l.lines.slice(0,l.labelLines).forEach((_,w)=>e.fillText(_,b+l.size*.6,p(w))),e.fillText(l.lines[l.labelLines],y+l.rampWidth+l.size*.6,g)}e.restore()}a(gs,"drawCanvasVectorField");function sf({data:e,dimension:t,renderState:o,plotRect:r,crop:i,ink:n,fontFamily:s,fontSizePx:f,haloColor:c,inPlotKey:l}){if(e.vectorField===null||e.vectorField===void 0)return"";let u=Vn({vectorField:e.vectorField,positions:e.positions,dimension:t,transparency:e.transparency,renderState:o,plotRect:r,crop:i});return ys(u,{plotRect:r,ink:n,fontFamily:s,fontSizePx:f,haloColor:c,inPlotKey:l})}a(sf,"vectorFieldSvgOf");function lf(e,{data:t,dimension:o,renderState:r,plotRect:i,crop:n,ink:s,fontFamily:f,fontSizePx:c,haloColor:l,inPlotKey:u}){if(t.vectorField===null||t.vectorField===void 0)return;let d=Vn({vectorField:t.vectorField,positions:t.positions,dimension:o,transparency:t.transparency,renderState:r,plotRect:i,crop:n});gs(e,d,{plotRect:i,ink:s,fontFamily:f,fontSizePx:c,haloColor:l,inPlotKey:u})}a(lf,"drawCanvasVectorFieldOf");var Ro={wide:1.3,upper:.85,lowerOrDigit:.7,narrow:.45},ws=1.1;function vs(e,t,o=400){let r=0;for(let i of String(e??""))/[MWmw@%&]/.test(i)||i.codePointAt(0)>126?r+=Ro.wide:/[A-Z]/.test(i)?r+=Ro.upper:/[a-z0-9]/.test(i)?r+=Ro.lowerOrDigit:r+=Ro.narrow;return r*t*(o>=600?ws:1)}a(vs,"estimateTextWidth");var $o=null,fr="";function Es(){if($o!==null)return $o;if(typeof OffscreenCanvas!="function")return null;let e=null;try{e=new OffscreenCanvas(1,1).getContext("2d")}catch{return null}return e===null||typeof e.measureText!="function"?null:($o=e,fr="",$o)}a(Es,"canvasContext");function ur(e){let t=String(e||"Arial, Helvetica, sans-serif");return(o,r,i=400)=>{let n=Es();if(n===null)return vs(o,r,i);let s=`${i===400?"":`${i} `}${r}px ${t}`;return s!==fr&&(n.font=s,fr=s),n.measureText(String(o??"")).width}}a(ur,"figureTextMeasure");var De=20,Fo=34,hr=14,Gt=16,_s=10,ri=a(e=>_s*e,"legendMinWidthBeside"),Ms=10,Oo=8,dr=96,As=.5,ni=80,Ts=64,At=1e-6;function ii(e){let t=Number(e);return t>0?t:hr}a(ii,"titleFontOf");function ai(e){let t=Number(e);return t>0?t:12}a(ai,"legendFontOf");function si({width:e,height:t,plotAspect:o,title:r="",titleFontSizePx:i=hr,axes:n=null,includeLegend:s=!0,legendPosition:f="right",legendModel:c=null,legendFieldKey:l=null,legendHighlight:u=null,legendVectorKey:d=null,legendFontSizePx:p=12,fontFamily:g="Arial, Helvetica, sans-serif",measureText:v=null}){let A=v??ur(g),y=String(r||"").trim(),b=y!=="",M=ii(i),{width:_,height:w}=on({aspect:o,width:Math.max(1,Math.round(e)),height:Math.max(1,Math.round(t))}),x=n===null?null:cr({...n,plotWidth:_,plotHeight:w,measureText:A}),O=a(ue=>Math.max(Ms,x===null?0:x.margins[ue]),"margin"),k=O("left"),D=O("right"),$=O("top"),R=O("bottom"),U=b?Fo:0,B={x:De+k,y:De+U+$,width:_,height:w},V=B.x+_+D,I=B.y+w+R,j=null,N=null;if(s&&(c||u||d)){let ue=ai(p);f==="right"?(N=_t({model:c,fieldKey:l,fontPx:ue,measureText:A,placement:"beside",extentPx:w,minWidth:ri(ue),highlight:u,vectorKey:d}),j={x:V+Gt,y:B.y,width:N.width,height:N.height}):(N=_t({model:c,fieldKey:l,fontPx:ue,measureText:A,placement:"below",extentPx:_,highlight:u,vectorKey:d}),j={x:B.x,y:I+Gt,width:N.width,height:N.height})}let z=b?A(y,M):0,C=Math.max(V,j?j.x+j.width:0,De+z),F=Math.max(I,j?j.y+j.height:0),P=Math.ceil(C+De),Y=Math.ceil(F+De);return{outerPadding:De,totalWidth:P,totalHeight:Y,titleFontPx:M,titleRect:b?{x:De,y:De,width:P-De*2,height:Fo}:null,plotRect:B,axes:x,legendRect:j,legendPlan:N,vectorKeyInLegend:N!==null&&N.vectorKey!==null&&N.vectorKey!==void 0}}a(si,"computeSingleViewLayout");function Ss(e,t){return e.label===t.label&&e.speed===t.speed&&e.colormapId===t.colormapId}a(Ss,"sameVectorKey");function ks(e,t){if(!Number.isSafeInteger(e)||e<1)throw new RangeError("A grid figure arranges one or more panels.");if(!Number.isSafeInteger(t)||t<1)throw new RangeError("A grid figure needs its arrangement's columns (a whole number, at least 1).");let o=Math.min(t,e);return{cols:o,rows:Math.ceil(e/o)}}a(ks,"computeGridDims");function Rs(e){return{padding:Ne(Math.round(e*.65),6,12),header:Math.max(18,Math.round(e*1.5))}}a(Rs,"gridCellMetrics");function $s({plotHeight:e,cols:t,rows:o,plotAspects:r,titleWidths:i,panelAxes:n,paneLegends:s,sharedLegend:f,legendPosition:c,metrics:l,legendFontPx:u,measure:d}){let{padding:p,header:g}=l,v=new Array(t).fill(0),A=new Array(t).fill(0),y=new Array(t).fill(0),b=new Array(t).fill(0),M=new Array(o).fill(0),_=new Array(o).fill(0),w=new Array(o).fill(0),x=new Array(o).fill(0),O=a(F=>F%t,"colOf"),k=a(F=>Math.floor(F/t),"rowOf"),D=r.map((F,P)=>{let Y=O(P),ue=k(P);if(y[Y]=Math.max(y[Y],e*F),n[P]===null)return null;let ke=cr({...n[P],plotWidth:e*F,plotHeight:e,measureText:d});return v[Y]=Math.max(v[Y],ke.margins.left),A[Y]=Math.max(A[Y],ke.margins.right),M[ue]=Math.max(M[ue],ke.margins.top),_[ue]=Math.max(_[ue],ke.margins.bottom),ke}),$=s.map((F,P)=>{if(F===null||F.side!=="right")return null;let Y=_t({model:F.model,fieldKey:F.fieldKey,fontPx:u,measureText:d,placement:"beside",extentPx:e,minWidth:dr,highlight:F.highlight,vectorKey:F.vectorKey});return b[O(P)]=Math.max(b[O(P)],Oo+Y.width),x[k(P)]=Math.max(x[k(P)],Y.height),Y}),R=y.map((F,P)=>v[P]+F+A[P]+b[P]);i.forEach((F,P)=>{let Y=O(P),ue=v[Y]+(y[Y]-e*r[P])/2;R[Y]=Math.max(R[Y],ue+F)});let U=a((F,P)=>_t({model:F.model,fieldKey:F.fieldKey,fontPx:u,measureText:d,placement:"below",extentPx:P,minWidth:dr,highlight:F.highlight,vectorKey:F.vectorKey}),"planBelow");s.forEach((F,P)=>{if(F===null||F.side!=="below")return;let Y=O(P);R[Y]=Math.max(R[Y],U(F,R[Y]).width)}),s.forEach((F,P)=>{if(F===null||F.side!=="below")return;let Y=U(F,R[O(P)]);$[P]=Y,w[k(P)]=Math.max(w[k(P)],Oo+Y.height)});let B=R.map(F=>p*2+F),V=_.map((F,P)=>p*2+g+M[P]+Math.max(e+F+w[P],x[P])),I=B.reduce((F,P)=>F+P,0),j=V.reduce((F,P)=>F+P,0),N=null,z=I,C=j;return f!==null&&c==="right"?(N=_t({model:f.model,fieldKey:f.fieldKey,fontPx:u,measureText:d,placement:"beside",extentPx:j-p*2-g-M[0],minWidth:ri(u),highlight:f.highlight,vectorKey:f.vectorKey}),z=I+Gt+N.width,C=Math.max(j,p+g+M[0]+N.height)):f!==null&&(N=_t({model:f.model,fieldKey:f.fieldKey,fontPx:u,measureText:d,placement:"below",extentPx:I-p*2,highlight:f.highlight,vectorKey:f.vectorKey}),z=Math.max(I,p*2+N.width),C=j+Gt+N.height),{plotHeight:e,axes:D,colAxisLeft:v,colAxisRight:A,colPlotWidth:y,rowAxisTop:M,rowAxisBottom:_,colWidths:B,rowHeights:V,gridWidth:I,gridHeight:j,plans:$,sharedPlan:N,contentWidth:z,contentHeight:C}}a($s,"composeGrid");function li({width:e,height:t,columns:o,views:r,plotAspects:i,panelAxes:n,title:s="",titleFontSizePx:f=hr,includeLegend:c=!0,legendPosition:l="right",legendHighlight:u=null,legendVectorKeys:d=null,fontSize:p,legendFontSizePx:g=12,fontFamily:v="Arial, Helvetica, sans-serif",measureText:A=null}){if(!Array.isArray(i)||i.length!==r.length)throw new TypeError("Grid figure layout requires one plot aspect per view.");if(!Array.isArray(n)||n.length!==r.length||n.some(G=>G!==null&&(typeof G!="object"||typeof G.bounds!="object"||G.bounds===null)))throw new TypeError("Grid figure layout requires what each panel's axes show, or null (figurePanelAxes).");if(u!==null&&(!Array.isArray(u.panels)||u.panels.length!==r.length))throw new TypeError("Grid figure layout requires whether each panel draws highlighted cells.");for(let G of i)if(!(typeof G=="number"&&Number.isFinite(G)&&G>0))throw new TypeError("A grid panel's plot aspect must be a finite positive number.");let y=A??ur(v),b=String(s||"").trim(),M=b!=="",_=ii(f),w=ai(g),x=M?Fo:0,O=De,k=De+x,D=Math.max(1,Math.round(e)),$=Math.max(1,Math.round(t)),{cols:R,rows:U}=ks(r.length,o),B=Rs(p),V=a(G=>u!==null&&u.panels[G]?u.entry:null,"highlightOf"),I=u!==null&&u.panels.some(Boolean)?u.entry:null;if(d!==null&&(!Array.isArray(d)||d.length!==r.length))throw new TypeError("Grid figure layout requires one vector field key (or null) per panel.");let j=a(G=>c&&d!==null?d[G]??null:null,"vectorKeyOf"),N=r.map((G,J)=>j(J)).filter(G=>G!==null),z=N.length>0&&N.every(G=>Ss(G,N[0]))?N[0]:null,C=c?Dn(r):null,F=r.every(G=>G.scientificState.legendModel==null),P=N.length===0||z!==null,Y=C!==null?{...C,highlight:I,vectorKey:z}:c&&F&&P&&(I!==null||z!==null)?{fieldKey:null,model:null,highlight:I,vectorKey:z}:null,ue=r.map((G,J)=>y(Hn(G,J),p)),ke=Ts;for(let G of i)ke=Math.max(ke,ni/G);ke=Math.ceil(ke-At);let Ke=a((G,J,Q=Y)=>$s({plotHeight:G,cols:R,rows:U,plotAspects:i,titleWidths:ue,panelAxes:n,paneLegends:J,sharedLegend:Q,legendPosition:l,metrics:B,legendFontPx:w,measure:y}),"compose"),Ue=a(G=>Math.max((De*2+G.contentWidth)/D,(De*2+x+G.contentHeight)/$),"overflowOf"),ee=a((G,J,Q=!0)=>Ue(Ke(G,J,Q?Y:null))<=1+At,"fitsAt"),xe=a((G,J=!0)=>{let Q=a(ge=>ee(ge,G,J),"fits"),q=ke;if(!Q(q))return q;let oe=Math.max(q,$);if(Q(oe))return oe;for(;oe-q>1;){let ge=Math.floor((q+oe)/2);Q(ge)?q=ge:oe=ge}return q},"largestFitting"),$e=xe(r.map(()=>null),!1),be=r.map(()=>null);if(c&&Y===null){let G=r.map((Q,q)=>{let oe=Q.scientificState.legendModel??null,ge=V(q),rt=j(q);return oe===null&&ge===null&&rt===null?null:{model:oe,fieldKey:oe===null?null:Q.scientificState.fieldKey,highlight:ge,vectorKey:rt}}),J=a(Q=>G.map(q=>q===null?null:{...q,side:Q}),"sided");if(l==="right"){let Q=G.map((q,oe)=>{if(q===null)return null;let ge=_t({model:q.model,fieldKey:q.fieldKey,fontPx:w,measureText:y,placement:"beside",extentPx:$e,minWidth:dr,highlight:q.highlight,vectorKey:q.vectorKey});return{...q,side:ge.width<=$e*i[oe]?"right":"below"}});be=H([Q,J("right"),J("below")])}else be=J("below")}function T(G){return Math.max(xe(G),Math.min($e,Math.ceil($e*As-At)),ke)}a(T,"heightFor");function H(G){let J=null;for(let Q of G){let q=T(Q),oe=Math.max(1,Ue(Ke(q,Q)));if(oe<=1+At)return Q;(J===null||oe<J.overflow-At||Math.abs(oe-J.overflow)<=At&&q>J.plotHeight)&&(J={arrangement:Q,plotHeight:q,overflow:oe})}return J.arrangement}a(H,"arrangementOf");let te=T(be),W=Ke(te,be),{plotHeight:ae}=W,{padding:Z,header:ne}=B,we=[],Se=O;for(let G of W.colWidths)we.push(Se),Se+=G;let Oe=[],me=k;for(let G of W.rowHeights)Oe.push(me),me+=G;let Ee=r.map((G,J)=>{let Q=J%R,q=Math.floor(J/R),oe=we[Q],ge=Oe[q],rt=ae*i[J],Ce=oe+Z+W.colAxisLeft[Q],de={x:Ce+(W.colPlotWidth[Q]-rt)/2,y:ge+Z+ne+W.rowAxisTop[q],width:rt,height:ae},se=be[J],le=W.plans[J],he=null;return se!==null&&se.side==="right"?he={x:Ce+W.colPlotWidth[Q]+W.colAxisRight[Q]+Oo,y:de.y,width:le.width,height:le.height}:se!==null&&(he={x:oe+Z,y:de.y+ae+W.rowAxisBottom[q]+Oo,width:le.width,height:le.height}),{legendModel:se?.model??null,legendFieldKey:se?.fieldKey??null,legendPlan:se===null?null:le,legendSide:se?.side??null,labelX:de.x,labelY:ge+Z+Math.min(p,ne),panelRect:{x:oe+1,y:ge+1,width:W.colWidths[Q]-2,height:W.rowHeights[q]-2},plotRect:de,axes:W.axes[J],legendRect:he,vectorKeyInLegend:j(J)!==null&&(se!==null&&se.vectorKey!==null||Y!==null&&Y.vectorKey!==null)}}),Le=null;W.sharedPlan!==null&&(Le=l==="right"?{x:O+W.gridWidth+Gt,y:k+Z+ne+W.rowAxisTop[0],width:W.sharedPlan.width,height:W.sharedPlan.height}:{x:O+Z,y:k+W.gridHeight+Gt,width:W.sharedPlan.width,height:W.sharedPlan.height});let Pe=M?y(b,_):0,Me=Math.ceil(Math.max(O+W.contentWidth,De+Pe)+De-At),ye=Math.ceil(k+W.contentHeight+De-At);return{outerPadding:De,totalWidth:Me,totalHeight:ye,plotHeight:ae,titleFontPx:_,titleRect:M?{x:De,y:De,width:Me-De*2,height:Fo}:null,sharedLegend:Y,sharedLegendRect:Le,sharedLegendPlan:W.sharedPlan,panes:Ee}}a(li,"computeGridFigureLayout");function vf(e,{includeLegend:t=e.options.includeLegend}={}){let o=e.options,r=e.views,i=o.crop,n=Kn(r,o.includeAxes),s=r.map((p,g)=>{if(!n[g])return null;let v=Wn({renderState:p.renderState,crop:i,dimension:p.scientificState.dimensionLevel,cameraState:p.cameraState,normTransform:p.scientificState.normTransform});return v===null?null:{bounds:v,xLabel:o.xLabel,yLabel:o.yLabel,tickFontPx:o.tickFontSizePx,labelFontPx:o.axisLabelFontSizePx}}),f=t?an(e):null,c=r.map(p=>t&&p.data?.vectorField?Qn(p.data.vectorField):null),l=r.map(p=>tn({renderState:p.renderState,crop:i})),u={width:e.width,height:e.height,title:e.title.trim(),titleFontSizePx:o.titleFontSizePx,includeLegend:t,legendPosition:o.legendPosition,legendFontSizePx:o.legendFontSizePx,fontFamily:o.fontFamily};if(r.length===1){let p=r[0].scientificState,g={...u,plotAspect:l[0],axes:s[0],legendModel:t?p.legendModel:null,legendFieldKey:t?p.fieldKey:null,legendHighlight:f?.entry??null,legendVectorKey:c[0]};return{single:e.height===null?Fs(g):si(g),grid:null}}let d={...u,columns:e.gridColumns,views:r,plotAspects:l,panelAxes:s,legendHighlight:f,legendVectorKeys:c,fontSize:o.fontSizePx};return{single:null,grid:e.height===null?Os(d):li(d)}}a(vf,"computeFigureLayout");function ci(e,t){return e.totalWidth>=t?e:{...e,totalWidth:t,titleRect:e.titleRect===null?null:{...e.titleRect,width:t-e.outerPadding*2}}}a(ci,"widenTo");function Fs(e){let t=oi(e);if(t.totalWidth<=Math.round(e.width)||e.legendPosition!=="right"||t.legendRect===null)return{...t,legendMovedBelow:!1};let o=oi({...e,legendPosition:"bottom"});return o.totalWidth<t.totalWidth?{...o,legendMovedBelow:!0}:{...t,legendMovedBelow:!1}}a(Fs,"fillSingleViewWidth");function oi(e){let t=Math.max(1,Math.round(e.width)),o=e.plotAspect,r=Math.min(ni,t),i=a(f=>si({...e,width:f,height:Math.max(1,Math.ceil(f/o))}),"at"),n=t;for(;;){let f=i(n),c=f.totalWidth-t;if(c<=0)return ci(f,t);let l=Math.min(n-1,n-c);if(l<r)break;n=l}let s=null;for(let f=r;;f=Math.min(t,Math.ceil(f*1.25))){let c=i(f);if((s===null||c.totalWidth<s.totalWidth)&&(s=c),f>=t)break}return s}a(oi,"fillWithLegendAsAsked");function Os(e){let t=Math.max(1,Math.round(e.width)),o=Math.ceil(t/Math.min(...e.plotAspects))*Math.max(1,e.views.length);return ci(li({...e,height:o+t}),t)}a(Os,"fillGridWidth");function zo(e){return Number(e)*180/Math.PI}a(zo,"toDegrees");function Co(e){let t=Number(e);if(!Number.isFinite(t))return 0;for(;t<=-180;)t+=360;for(;t>180;)t-=360;return t}a(Co,"normalizeDegrees");function jt(e,t){let o=e,r=t[0],i=t[1],n=t[2];return[o[0]*r+o[4]*i+o[8]*n,o[1]*r+o[5]*i+o[9]*n,o[2]*r+o[6]*i+o[10]*n]}a(jt,"transformDirection");function fi(e,t){return Math.sqrt(e*e+t*t)||1}a(fi,"length2");function zs(e,t,o,r,i,n){let s=Ne(n,0,Math.min(r,i)/2);if(typeof e.roundRect=="function"){e.beginPath(),e.roundRect(t,o,r,i,s);return}e.beginPath(),e.moveTo(t+s,o),e.arcTo(t+r,o,t+r,o+i,s),e.arcTo(t+r,o+i,t,o+i,s),e.arcTo(t,o+i,t,o,s),e.arcTo(t,o,t+r,o,s),e.closePath()}a(zs,"beginRoundRectPath");function ui(e,t){if(typeof t!="number"||!Number.isFinite(t)||t<=0)throw new TypeError("Orientation indicator plotScale must be a finite positive number.");return{x:0,y:0,width:e.width/t,height:e.height/t}}a(ui,"viewportFrameOf");function di(e){let t=st(e,"Orientation-indicator camera state"),o=t.navigationMode;if(o==="orbit"){let r=t.orbit.theta,i=t.orbit.phi,n=Co(zo(r)),s=Ne(Co(90-zo(i)),-90,90);return[`az ${n.toFixed(0)}°`,`el ${s.toFixed(0)}°`]}if(o==="free"){let r=t.freefly.yaw,i=t.freefly.pitch,n=Co(zo(r)),s=Ne(Co(zo(i)),-90,90);return[`yaw ${n.toFixed(0)}°`,`pit ${s.toFixed(0)}°`]}return[]}a(di,"getAngleLines");function kf({plotRect:e,plotScale:t,viewMatrix:o,cameraState:r,fontFamily:i="Arial, Helvetica, sans-serif",fontSize:n=11,sizePx:s=null,marginPx:f=null,padPx:c=null,ink:l=Et}){let u=l.surfaceInk;if(!e||!o)return"";let d=ui(e,t),p=Ne(Math.round(Number(n)||11),6,48),g=Ne(Math.round(Number.isFinite(f)?f:p*.9),8,18),v=Math.floor(Math.min(d.width,d.height)-g*2);if(!Number.isFinite(v)||v<50)return"";let A=Number.isFinite(s)?s:p*6.5,y=Ne(Math.round(A),76,Math.min(160,v)),b=Ne(Math.round(Number.isFinite(c)?c:p*.7),6,Math.max(6,Math.round(y*.18))),M=Math.max(2,Math.round(p/5)),_=Ne(Math.round(p*.55),6,10),w=d.x+d.width-y-g,x=d.y+g,O=w+y/2,k=di(r),D=Math.max(10,Math.round(p*1.15)),$=k.length?k.length*D+4:0,R=Math.max(1,y-b*2-$),U=x+b+R/2,B=Math.max(10,Math.min(y-b*2,R)*.38),V=jt(o,[1,0,0]),I=jt(o,[0,1,0]),j=jt(o,[0,0,1]),N=[{name:"X",v:V,color:"#ef4444"},{name:"Y",v:I,color:"#22c55e"},{name:"Z",v:j,color:"#3b82f6"}];N.sort((C,F)=>(F.v[2]||0)-(C.v[2]||0));let z=[];z.push(`<g transform="translate(${e.x} ${e.y}) scale(${t})" font-family="${ce(i)}" font-size="${p}" fill="${ce(u)}">`),z.push(`<rect x="${w}" y="${x}" width="${y}" height="${y}" rx="${_}" fill="${l.surface}" fill-opacity="0.85" stroke="${l.frame}" stroke-width="1"/>`);for(let C of N){let F=C.v[0],P=C.v[1],Y=C.v[2],ue=fi(F,P),ke=F/ue*B,Ke=-P/ue*B,Ue=Ne(.35+(1-(Y+1)/2)*.65,.35,1),ee=O+ke,xe=U+Ke,$e=ke/Math.max(1e-6,B),be=Ke/Math.max(1e-6,B),T=Ne(Math.round(p*.55),5,10),H=ee+$e*T,te=xe+be*T,W=$e>.25?"start":$e<-.25?"end":"middle";z.push(`<line x1="${O}" y1="${U}" x2="${ee}" y2="${xe}" stroke="${C.color}" stroke-width="${M}" stroke-linecap="round" opacity="${Ue.toFixed(3)}"/>`),z.push(`<text x="${H}" y="${te}" text-anchor="${W}" dominant-baseline="middle" fill="${C.color}" font-weight="600" opacity="${Ue.toFixed(3)}" stroke="none">${C.name}</text>`)}if(k.length){let C=x+y-b;for(let F=0;F<k.length;F++){let P=C-(k.length-1-F)*D;z.push(`<text x="${w+y/2}" y="${P}" text-anchor="middle" fill="${l.surfaceInk}" stroke="none">${ce(k[F])}</text>`)}}return z.push("</g>"),z.join("")}a(kf,"renderSvgOrientationIndicator");function Rf({ctx:e,plotRect:t,plotScale:o,viewMatrix:r,cameraState:i,fontFamily:n="Arial, Helvetica, sans-serif",fontSize:s=11,sizePx:f=null,marginPx:c=null,padPx:l=null,ink:u=Et}){if(!e||!t||!r)return;let d=ui(t,o),p=Ne(Math.round(Number(s)||11),6,48),g=Ne(Math.round(Number.isFinite(c)?c:p*.9),8,18),v=Math.floor(Math.min(d.width,d.height)-g*2);if(!Number.isFinite(v)||v<50)return;let A=Number.isFinite(f)?f:p*6.5,y=Ne(Math.round(A),76,Math.min(160,v)),b=Ne(Math.round(Number.isFinite(l)?l:p*.7),6,Math.max(6,Math.round(y*.18))),M=Math.max(2,Math.round(p/5)),_=Ne(Math.round(p*.55),6,10),w=d.x+d.width-y-g,x=d.y+g,O=w+y/2,k=di(i),D=Math.max(10,Math.round(p*1.15)),$=k.length?k.length*D+4:0,R=Math.max(1,y-b*2-$),U=x+b+R/2,B=Math.max(10,Math.min(y-b*2,R)*.38),V=jt(r,[1,0,0]),I=jt(r,[0,1,0]),j=jt(r,[0,0,1]),N=[{name:"X",v:V,color:"#ef4444"},{name:"Y",v:I,color:"#22c55e"},{name:"Z",v:j,color:"#3b82f6"}];N.sort((z,C)=>(C.v[2]||0)-(z.v[2]||0)),e.save(),e.translate(t.x,t.y),e.scale(o,o),e.globalAlpha=.85,e.fillStyle=u.surface,e.strokeStyle=u.frame,e.lineWidth=1,zs(e,w,x,y,y,_),e.fill(),e.globalAlpha=1,e.stroke();for(let z of N){let C=z.v[0],F=z.v[1],P=z.v[2],Y=fi(C,F),ue=C/Y*B,ke=-F/Y*B,Ke=Ne(.35+(1-(P+1)/2)*.65,.35,1),Ue=O+ue,ee=U+ke;e.globalAlpha=Ke,e.strokeStyle=z.color,e.lineWidth=M,e.beginPath(),e.moveTo(O,U),e.lineTo(Ue,ee),e.stroke();let xe=ue/Math.max(1e-6,B),$e=ke/Math.max(1e-6,B),be=Ne(Math.round(p*.55),5,10),T=Ue+xe*be,H=ee+$e*be;e.fillStyle=z.color,e.font=`600 ${p}px ${n}`,e.textAlign=xe>.25?"left":xe<-.25?"right":"center",e.textBaseline="middle",e.fillText(z.name,T,H)}if(e.globalAlpha=1,k.length){e.fillStyle=u.surfaceInk,e.font=`${p}px ${n}`,e.textAlign="center",e.textBaseline="alphabetic";let z=x+y-b;for(let C=0;C<k.length;C++){let F=z-(k.length-1-C)*D;e.fillText(k[C],w+y/2,F)}}e.restore()}a(Rf,"drawCanvasOrientationIndicator");function hi(e){return{points:!!e?.points,labels:!!e?.labels}}a(hi,"normalizeFlags");function pi(e,t){if(!Array.isArray(e)||!Number.isFinite(t))return"";let o=e[t];return o==null?"":String(o)}a(pi,"getLabelAtIndex");function Pf({positions:e,colors:t,labelTexts:o=null,flags:r=null,renderState:i,plotRect:n,pointDiameterViewportPx:s,crop:f=null,fontFamily:c="Arial, Helvetica, sans-serif",labelFontSizePx:l=12,labelColor:u="#111",haloColor:d="#ffffff"}){let p=hi(r);if(!p.points&&!p.labels||!e||!t||!i?.mvpMatrix)return"";let g=Math.max(6,Math.round(Number(l)||12)),v=Math.max(1.5,Math.round(g*.28)),A=ce(u),y=[];return y.push(`<g font-family="${ce(c)}" fill="${ce(u)}">`),Ko({positions:e,dimension:3,colors:t,colorAlpha:"opacity",transparency:null,renderState:i,plotRect:n,pointDiameterViewportPx:s,lodMembership:null,crop:f,sortByDepth:!1,onPoint:a((b,M,_,w,x,O,k,D)=>{if(!(O<Go)){if(p.points){let $=`rgb(${_},${w},${x})`,R=Math.max(.5,Math.min(2.5,k*.18));O>=.999?y.push(`<circle cx="${b.toFixed(2)}" cy="${M.toFixed(2)}" r="${k.toFixed(2)}" fill="${$}" stroke="${A}" stroke-width="${R.toFixed(2)}"/>`):y.push(`<circle cx="${b.toFixed(2)}" cy="${M.toFixed(2)}" r="${k.toFixed(2)}" fill="${$}" fill-opacity="${O.toFixed(3)}" stroke="${A}" stroke-width="${R.toFixed(2)}" stroke-opacity="${O.toFixed(3)}"/>`)}if(p.labels){let $=pi(o,D);if(!$)return;let R=ce($),U=b.toFixed(2),B=M.toFixed(2);y.push(`<text x="${U}" y="${B}" font-size="${g}" text-anchor="middle" dy="0.35em" stroke="${ce(d)}" stroke-width="${v}" stroke-linejoin="round" fill="none">${R}</text>`),y.push(`<text x="${U}" y="${B}" font-size="${g}" text-anchor="middle" dy="0.35em" fill="${ce(u)}">${R}</text>`)}}},"onPoint")}),y.push("</g>"),y.join("")}a(Pf,"renderSvgCentroidOverlay");function If({ctx:e,positions:t,colors:o,labelTexts:r=null,flags:i=null,renderState:n,plotRect:s,pointDiameterViewportPx:f,crop:c=null,fontFamily:l="Arial, Helvetica, sans-serif",labelFontSizePx:u=12,labelColor:d="#111",haloColor:p="rgba(255,255,255,0.95)"}){let g=hi(i);if(!g.points&&!g.labels||!e||!t||!o||!n?.mvpMatrix)return;let v=Math.max(6,Math.round(Number(u)||12)),A=Math.max(1,Math.round(v*.28)),y=Lt(d),b=y===null?[17,17,17]:y.map(M=>Math.round(M*255));e.save(),e.font=`${v}px ${l}`,e.textAlign="center",e.textBaseline="alphabetic",Ko({positions:t,dimension:3,colors:o,colorAlpha:"opacity",transparency:null,renderState:n,plotRect:s,pointDiameterViewportPx:f,lodMembership:null,crop:c,sortByDepth:!1,onPoint:a((M,_,w,x,O,k,D,$)=>{if(!(k<Go)&&(g.points&&(e.fillStyle=`rgba(${w},${x},${O},${k})`,e.beginPath(),e.arc(M,_,D,0,Math.PI*2),e.fill(),e.strokeStyle=`rgba(${b[0]},${b[1]},${b[2]},${k})`,e.lineWidth=Math.max(.5,Math.min(2.5,D*.18)),e.stroke()),g.labels)){let R=pi(r,$);if(!R)return;e.lineWidth=A,e.strokeStyle=p,e.fillStyle=d,e.strokeText(R,M,_+v*.35),e.fillText(R,M,_+v*.35)}},"onPoint")}),e.restore()}a(If,"drawCanvasCentroidOverlay");var pr=64,mr=40,mi=24,yi=12,bi=.5/255,xi=Math.log(qe.ratio);function Lo(e,t,o){return[e[0]+(t[0]-e[0])*o,e[1]+(t[1]-e[1])*o,e[2]+(t[2]-e[2])*o]}a(Lo,"mixRgb");function yr(e){if(e===0)return 1/0;let t=0,o=Math.abs(e);for(;o%qe.ratio===0&&t<64;)o/=qe.ratio,t+=1;return t}a(yr,"divisibilityDepth");function wi({appearance:e,renderState:t,plotRect:o,crop:r=null,surface:i}){let n=t?.backdrop;if(!(t?.mvpMatrix instanceof Float32Array)||t.mvpMatrix.length!==16||!(t.viewMatrix instanceof Float32Array)||t.viewMatrix.length!==16||!Array.isArray(t.cameraPosition)||n===null||typeof n!="object")throw new TypeError("Studio backdrop export requires exact matrices, the camera position, and the pane backdrop.");if(!Number.isFinite(o?.width)||o.width<=0||!Number.isFinite(o?.height)||o.height<=0)throw new TypeError("Studio backdrop export requires a positive plot rectangle.");if(!Array.isArray(i?.rgb)||i.rgb.length!==3||typeof i.viewerPaper!="boolean")throw new TypeError("Studio backdrop export requires the resolved figure surface.");let s=e.palette,f=qt(s.ink),c=qt(s.glow),l=i.rgb,u=t.mvpMatrix,d=t.cameraPosition,p=n.pixelRatio,g=So({renderState:t,plotRect:o,crop:r}),{viewportW:v,viewportH:A,srcX0:y,srcY0:b,srcW:M,srcH:_,scale:w}=g,x=ko(u);if(x===null)return null;let O=n.glowCenterX,k=Math.max(1-O,.001),D=i.viewerPaper,$=dn(n.planarity,{}),R=$.floor,U=pn(u,d,n,{}),B=U.gate*s.poolAlpha*R,V=U.axisAX*U.axisBY-U.axisBX*U.axisAY,I=a((T,H)=>{let te=T/v*2-1,W=1-H/A*2,ae=l;if(D){let Z=Math.hypot((te-O)/k,W);ae=Lo(ae,c,go(Z))}if(B>0){let Z=te-U.centerX,ne=W-U.centerY,we=(U.axisBY*Z-U.axisBX*ne)/V,Se=(-U.axisAY*Z+U.axisAX*ne)/V;ae=Lo(ae,f,go(Math.hypot(we,Se))*B)}return ae},"baseAt"),j=a(T=>Math.max(Math.abs(f[0]-T[0]),Math.abs(f[1]-T[1]),Math.abs(f[2]-T[2])),"contrastAt"),N=a((T,H)=>T[0]*H[0]+T[1]*H[1]+T[2]*H[2],"dot3"),z=[];if(R>0&&z.push({normal:[0,1,0],offset:n.floorY,u:[1,0,0],v:[0,0,1],weight:R,lineMix:1,dotMix:0,surface:Vo.floor,floor:!0}),$.backdrop>0){let T=hn(t.viewMatrix,n,{});z.push({normal:[T.normalX,T.normalY,T.normalZ],offset:T.offset,u:[T.uX,T.uY,T.uZ],v:[T.vX,T.vY,T.vZ],weight:$.backdrop,lineMix:0,dotMix:1,surface:Vo.backdrop,floor:!1})}let C=a((T,H,te)=>[T.normal[0]*T.offset+T.u[0]*H+T.v[0]*te,T.normal[1]*T.offset+T.u[1]*H+T.v[1]*te,T.normal[2]*T.offset+T.u[2]*H+T.v[2]*te],"pointOn"),F=a((T,H)=>{let te=H[0]-d[0],W=H[1]-d[1],ae=H[2]-d[2],Z=Math.hypot(te,W,ae);if(!(Z>0))return 0;if(T.floor)return T.weight*un(Math.hypot(H[0]-n.stageX,H[2]-n.stageZ))*wo(-W/Z)*vo(d[1]-T.offset);let ne=T.offset-N(T.normal,d),we=N(T.normal,[te,W,ae]);return ne*we<0?0:T.weight*wo(Math.abs(we)/Z)*vo(Math.abs(ne))},"fadeAt"),P=a((T,H)=>{let te=1e-4*Math.max(1,Math.hypot(H[0]-d[0],H[1]-d[1],H[2]-d[2])),W=g.clipToViewport(ot(u,H)),ae=H.map((Me,ye)=>Me+T.u[ye]*te),Z=H.map((Me,ye)=>Me+T.v[ye]*te),ne=g.clipToViewport(ot(u,ae)),we=g.clipToViewport(ot(u,Z));if(W===null||ne===null||we===null)return null;let Se=(ne.x-W.x)/te,Oe=(ne.y-W.y)/te,me=(we.x-W.x)/te,Ee=(we.y-W.y)/te,Le=Math.abs(Se*Ee-me*Oe);if(!(Le>0))return null;let Pe=Math.max(Math.hypot(me,Ee)/Le,Math.hypot(Se,Oe)/Le);return{screen:W,footprint:Pe,level:fn(T.surface,Pe,p)}},"footprintAt"),Y=[],ue=[];for(let T of z){let H=[];for(let me=0;me<=mr;me++)for(let Ee=0;Ee<=pr;Ee++){let Le=y+M*Ee/pr,Pe=b+_*me/mr,Me=Le/v*2-1,ye=1-Pe/A*2,G=[x[0]*Me+x[4]*ye+x[8]+x[12],x[1]*Me+x[5]*ye+x[9]+x[13],x[2]*Me+x[6]*ye+x[10]+x[14],x[3]*Me+x[7]*ye+x[11]+x[15]];if(!(Math.abs(G[3])>0))continue;let J=[G[0]/G[3]-d[0],G[1]/G[3]-d[1],G[2]/G[3]-d[2]],Q=N(T.normal,J);if(Math.abs(Q)<1e-12)continue;let q=(T.offset-N(T.normal,d))/Q;if(!(q>0))continue;let oe=[d[0]+J[0]*q,d[1]+J[1]*q,d[2]+J[2]*q];if(F(T,oe)<=0)continue;let ge=P(T,oe);ge!==null&&H.push({u:N(oe,T.u),v:N(oe,T.v),footprint:ge.footprint,visibleFrom:Math.ceil(Math.log(qe.fadeInFraction*T.surface.minCellCssPx*p*ge.footprint/qe.base)/xi-1e-9)})}if(H.length===0)continue;let te=1/0,W=1/0,ae=-1/0,Z=1/0,ne=-1/0;for(let me of H)te=Math.min(te,me.visibleFrom),W=Math.min(W,me.u),ae=Math.max(ae,me.u),Z=Math.min(Z,me.v),ne=Math.max(ne,me.v);let we=T.floor?2*Ye.outerRadius:Math.max(ae-W,ne-Z),Se=Math.max(te,Math.ceil(Math.log(Math.max(we,qe.base)/qe.base)/xi)+1),Oe=Math.max(M/pr,_/mr);for(let me=te;me<=Se;me++){let Ee=qo(me),Le=1/0,Pe=-1/0,Me=1/0,ye=-1/0,G=0;for(let Ce of H)Ce.visibleFrom>me||(Le=Math.min(Le,Ce.u),Pe=Math.max(Pe,Ce.u),Me=Math.min(Me,Ce.v),ye=Math.max(ye,Ce.v),G=Math.max(G,1.5*Oe*Ce.footprint));if(!(Pe>=Le))continue;Le-=G,Pe+=G,Me-=G,ye+=G,T.floor&&(Le=Math.max(Le,n.stageX-Ye.outerRadius),Pe=Math.min(Pe,n.stageX+Ye.outerRadius),Me=Math.max(Me,n.stageZ-Ye.outerRadius),ye=Math.min(ye,n.stageZ+Ye.outerRadius));let J=Math.ceil(Le/Ee),Q=Math.floor(Pe/Ee),q=Math.ceil(Me/Ee),oe=Math.floor(ye/Ee);if(Q<J||oe<q)continue;let ge=me===Se,rt=a(Ce=>ge||Ce%qe.ratio!==0,"ownsIndex");if(T.lineMix>0)for(let[Ce,de,se,le,he]of[[!0,J,Q,Me,ye],[!1,q,oe,Le,Pe]])for(let ve=de;ve<=se;ve++){if(!rt(ve))continue;let Ie=ve*Ee,Be=me+yr(ve);ke(T,Ce,Ie,Be,le,he)}if(T.dotMix>0){let Ce=[],de=0;for(let le of H){if(le.visibleFrom>me)continue;let he=1.5*Oe*le.footprint,ve=Math.max(J,Math.ceil((le.u-he)/Ee)),Ie=Math.min(Q,Math.floor((le.u+he)/Ee)),Be=Math.max(q,Math.ceil((le.v-he)/Ee)),lt=Math.min(oe,Math.floor((le.v+he)/Ee));Ie<ve||lt<Be||(Ce.push(ve,Ie,Be,lt),de+=(Ie-ve+1)*(lt-Be+1))}let se=a((le,he)=>{let ve=yr(le);for(let Ie of he)!ge&&ve>0&&Ie%qe.ratio===0||Ke(T,le*Ee,Ie*Ee,me+Math.min(ve,yr(Ie)))},"emitRow");if((Q-J+1)*(oe-q+1)<=de){let le=[];for(let he=q;he<=oe;he++)le.push(he);for(let he=J;he<=Q;he++)se(he,le)}else{let le=new Map;for(let ve=0;ve<Ce.length;ve+=4)for(let Ie=Ce[ve];Ie<=Ce[ve+1];Ie++){let Be=le.get(Ie);Be===void 0&&(Be=new Set,le.set(Ie,Be));for(let lt=Ce[ve+2];lt<=Ce[ve+3];lt++)Be.add(lt)}let he=a((ve,Ie)=>ve-Ie,"ascending");for(let ve of[...le.keys()].sort(he))se(ve,[...le.get(ve)].sort(he))}}}}function ke(T,H,te,W,ae,Z){let ne=ae,we=Z;if(T.floor){let de=H?n.stageX:n.stageZ,se=H?n.stageZ:n.stageX,le=Ye.outerRadius**2-(te-de)**2;if(!(le>0))return;let he=Math.sqrt(le);ne=Math.max(ne,se-he),we=Math.min(we,se+he)}if(!(we>ne))return;let Se=a(de=>H?C(T,te,de):C(T,de,te),"pointAt"),Oe=Se(ne),me=Se(we),Ee=To(ot(u,Oe),ot(u,me));if(Ee===null)return;let Le=Mt(Oe,me,Ee[0]),Pe=Mt(Oe,me,Ee[1]),Me=[],ye=0,G=0,J=!1;for(let de=0;de<=mi;de++){let se=Mt(Le,Pe,de/mi),le=P(T,se);if(le===null)return;let he=Jo({coarsestLevel:W,level:le.level,footprint:le.footprint,pixelRatio:p,surface:T.surface,minorAlpha:s.lineMinorAlpha,majorAlpha:s.lineMajorAlpha}),ve=F(T,se)*T.lineMix*he.strength,Ie=I(le.screen.x,le.screen.y);ve*j(Ie)>=bi&&(J=!0),ve>ye&&(ye=ve,G=he.majorness),Me.push({plot:g.viewportToPlot(le.screen.x,le.screen.y),color:dt(Lo(Ie,f,ve))})}if(!J)return;let Q=Me[0].plot,q=Me[Me.length-1].plot,oe=q.x-Q.x,ge=q.y-Q.y,rt=oe*oe+ge*ge;if(!(rt>0))return;let Ce=gt.lineWidthCssPx+(gt.majorLineWidthCssPx-gt.lineWidthCssPx)*G;Y.push({x1:Q.x,y1:Q.y,x2:q.x,y2:q.y,widthPx:Ce*p*w,stops:Me.map(de=>({offset:Math.min(1,Math.max(0,((de.plot.x-Q.x)*oe+(de.plot.y-Q.y)*ge)/rt)),color:de.color}))})}a(ke,"emitRule");function Ke(T,H,te,W){let ae=C(T,H,te),Z=P(T,ae);if(Z===null)return;let ne=gt.majorDotRadiusCssPx*p;if(Z.screen.x<y-ne||Z.screen.x>y+M+ne||Z.screen.y<b-ne||Z.screen.y>b+_+ne)return;let we=Jo({coarsestLevel:W,level:Z.level,footprint:Z.footprint,pixelRatio:p,surface:T.surface,minorAlpha:s.dotMinorAlpha,majorAlpha:s.dotMajorAlpha}),Se=F(T,ae)*T.dotMix*we.strength,Oe=I(Z.screen.x,Z.screen.y);if(Se*j(Oe)<bi)return;let me=gt.dotRadiusCssPx+(gt.majorDotRadiusCssPx-gt.dotRadiusCssPx)*we.majorness,Ee=g.viewportToPlot(Z.screen.x,Z.screen.y);ue.push({cx:Ee.x,cy:Ee.y,r:me*p*w,color:dt(Lo(Oe,f,Se))})}a(Ke,"emitDot");let Ue=.5*v*w,ee=-.5*A*w,xe=a((T,H,te,W,ae,Z)=>{let ne=g.viewportToPlot((T*.5+.5)*v,(.5-H*.5)*A);return[te*Ue,W*ee,ae*Ue,Z*ee,ne.x,ne.y]},"ellipseMatrix"),$e=a((T,H)=>{let te=[];for(let W=0;W<=yi;W++){let ae=W/yi;te.push({offset:ae,color:T,opacity:go(ae)*H})}return te},"falloffStops"),be=[];return D&&be.push({matrix:xe(O,0,k,0,0,1),stops:$e(dt(c),1)}),B>0&&be.push({matrix:xe(U.centerX,U.centerY,U.axisAX,U.axisAY,U.axisBX,U.axisBY),stops:$e(dt(f),B)}),be.length===0&&Y.length===0&&ue.length===0?null:{kind:"studio",rect:{x:o.x,y:o.y,width:o.width,height:o.height},gradients:be,segments:Y,dots:ue}}a(wi,"buildStudioBackdropModel");function gi(e){return e.map(t=>`<stop offset="${t.offset.toFixed(4)}" stop-color="${t.color}"`+(t.opacity===void 0?"":` stop-opacity="${t.opacity.toFixed(5)}"`)+"/>").join("")}a(gi,"formatStops");function vi(e,t){if(typeof t!="string"||!/^[A-Za-z][\w-]*$/.test(t))throw new TypeError("Studio backdrop SVG requires an exact element-id prefix.");let o=[],r=[],{rect:i}=e;if(e.gradients.forEach((n,s)=>{let f=`${t}-tone-${s}`;o.push(`<radialGradient id="${f}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${n.matrix.map(c=>c.toFixed(4)).join(" ")})">${gi(n.stops)}</radialGradient>`),r.push(`<rect x="${i.x}" y="${i.y}" width="${i.width}" height="${i.height}" fill="url(#${f})"/>`)}),e.segments.length>0&&(r.push('<g fill="none" stroke-linecap="butt">'),e.segments.forEach((n,s)=>{let f=`${t}-rule-${s}`;o.push(`<linearGradient id="${f}" gradientUnits="userSpaceOnUse" x1="${n.x1.toFixed(2)}" y1="${n.y1.toFixed(2)}" x2="${n.x2.toFixed(2)}" y2="${n.y2.toFixed(2)}">${gi(n.stops)}</linearGradient>`),r.push(`<line x1="${n.x1.toFixed(2)}" y1="${n.y1.toFixed(2)}" x2="${n.x2.toFixed(2)}" y2="${n.y2.toFixed(2)}" stroke="url(#${f})" stroke-width="${n.widthPx.toFixed(3)}"/>`)}),r.push("</g>")),e.dots.length>0){r.push('<g stroke="none">');for(let n of e.dots)r.push(`<circle cx="${n.cx.toFixed(2)}" cy="${n.cy.toFixed(2)}" r="${n.r.toFixed(3)}" fill="${n.color}"/>`);r.push("</g>")}return'<g class="cellucid-studio-backdrop">'+(o.length>0?`<defs>${o.join("")}</defs>`:"")+r.join("")+"</g>"}a(vi,"renderSvgStudioBackdrop");function Cs(e,t){if(t===void 0)return e;let[o,r,i]=Kr(e);return`rgba(${o}, ${r}, ${i}, ${t})`}a(Cs,"canvasColor");function Ei({ctx:e,model:t}){e.save();let{rect:o}=t;for(let r of t.gradients){e.save(),e.beginPath(),e.rect(o.x,o.y,o.width,o.height),e.transform(...r.matrix);let i=e.createRadialGradient(0,0,0,0,0,1);for(let n of r.stops)i.addColorStop(n.offset,Cs(n.color,n.opacity));e.fillStyle=i,e.fill(),e.restore()}e.lineCap="butt";for(let r of t.segments){let i=e.createLinearGradient(r.x1,r.y1,r.x2,r.y2);for(let n of r.stops)i.addColorStop(n.offset,n.color);e.beginPath(),e.moveTo(r.x1,r.y1),e.lineTo(r.x2,r.y2),e.strokeStyle=i,e.lineWidth=r.widthPx,e.stroke()}for(let r of t.dots)e.beginPath(),e.arc(r.cx,r.cy,r.r,0,Math.PI*2),e.fillStyle=r.color,e.fill();e.restore()}a(Ei,"drawCanvasStudioBackdrop");var Ls=.35,Ps=.16,Is=.6,Ns=.58,Ds=.5,Bs=.18,Us=.65,Gs=.32,js=.03,Xs=.55,Ks=.55,br=Object.freeze([.2126,.7152,.0722]),Ws=5,Ys=.5,Hs=.5*1.2,Vs=1.4,Zs=1.55,qs=-.2,Js=.05,Qs=.01,el=Object.freeze(["x","y","z"]),tl=Object.freeze([Object.freeze({key:"bottom",fixedAxis:1,fixedSign:-1,axisA:0,axisB:2}),Object.freeze({key:"top",fixedAxis:1,fixedSign:1,axisA:0,axisB:2}),Object.freeze({key:"back",fixedAxis:2,fixedSign:-1,axisA:0,axisB:1}),Object.freeze({key:"front",fixedAxis:2,fixedSign:1,axisA:0,axisB:1}),Object.freeze({key:"left",fixedAxis:0,fixedSign:-1,axisA:1,axisB:2}),Object.freeze({key:"right",fixedAxis:0,fixedSign:1,axisA:1,axisB:2})]),ol=0,rl=1,nl=2,il=3;function al(e,t,o){let r=Math.max(0,Math.min(1,(o-e)/(t-e)));return r*r*(3-2*r)}a(al,"smoothstep");function xr(e,t,o){return[e[0]+(t[0]-e[0])*o,e[1]+(t[1]-e[1])*o,e[2]+(t[2]-e[2])*o]}a(xr,"mixRgb");function Xt(e,t){if(!Array.isArray(e)&&!(e instanceof Float32Array)||e.length!==3||Array.from(e).some(o=>!Number.isFinite(o)||o<0||o>1))throw new TypeError(`${t} must contain exactly three 0..1 numbers.`);return[e[0],e[1],e[2]]}a(Xt,"assertRgb01");function sl(e,t){let o=Math.round(e/t);if(o<1||Math.abs(o*t-e)>1e-6)throw new RangeError("Reference grid spacing must divide the grid half-extent exactly.");let r=[];for(let i=-o;i<=o;i++){let n=i===0,s=Math.abs(i)===o,f=i%Ws===0,c=ol;n?c=il:s?c=nl:f&&(c=rl),r.push({coordinate:i*t,minor:!0,major:f,frame:s,origin:n,rank:c})}return r}a(sl,"enumerateRuleCoordinates");function ll({rule:e,strengths:t,lineWidth:o,lineColor:r,axisColor:i,surfaceRgb:n,effectiveOpacity:s}){let f=[{half:Ys,strength:t.minor,axis:!1}];e.major&&f.push({half:Hs,strength:t.major,axis:!1}),e.frame&&f.push({half:Vs,strength:t.frame,axis:!1}),e.origin&&f.push({half:Zs,strength:t.axis,axis:!0});let c=[...new Set(f.map(u=>u.half))].sort((u,d)=>d-u),l=[];for(let u of c){let d=0,p=0;for(let A of f)A.half<u||(A.axis?p=A.strength:d+=A.strength);if(d=Math.min(1,d),d<=0&&p<=0)continue;let g=xr(n,r,d);p>0&&(g=xr(g,i,p));let v=xr(n,g,s);l.push({halfWidthWorld:u*o,color:dt(v)})}return l}a(ll,"buildRuleBands");function Hf({appearance:e,background:t,backgroundColor:o}){if(e==null)return null;let r=[e.surfaceColor[0],e.surfaceColor[1],e.surfaceColor[2]];if(t==="transparent")return Object.freeze({rgb:r,viewerPaper:!1});let i=Lt(o);if(i===null)throw new TypeError("Reference grid export requires an exact #RRGGBB figure background.");return Object.freeze({rgb:i,viewerPaper:dt(i)===dt(r)})}a(Hf,"resolveReferenceGridSurface");function Vf({appearance:e,renderState:t,plotRect:o,crop:r=null,surface:i}){if(e==null||e.kind==="look")return null;if(e.kind==="studio")return wi({appearance:e,renderState:t,plotRect:o,crop:r,surface:i});if(!(t?.mvpMatrix instanceof Float32Array)||t.mvpMatrix.length!==16||!(t.viewMatrix instanceof Float32Array)||t.viewMatrix.length!==16)throw new TypeError("Reference grid export requires exact 16-value MVP and view matrices.");if(!Number.isFinite(o?.width)||o.width<=0||!Number.isFinite(o?.height)||o.height<=0)throw new TypeError("Reference grid export requires a positive plot rectangle.");let n=Xt(i?.rgb,"Reference grid surface color"),s=Xt(e.lineColor,"Reference grid line color"),f={x:Xt(e.axisColors.x,"Reference grid X-axis color"),y:Xt(e.axisColors.y,"Reference grid Y-axis color"),z:Xt(e.axisColors.z,"Reference grid Z-axis color")},c=Xt(e.surfaceColor,"Reference grid viewer surface color"),u=c[0]*br[0]+c[1]*br[1]+c[2]*br[2]>=Ks?1:0,d=e.size,p=e.spacing,g=e.lineWidth,v=e.opacity,A=t.mvpMatrix,y=t.viewMatrix,{toPlot:b}=So({renderState:t,plotRect:o,crop:r}),M=[-y[2],-y[6],-y[10]],_=sl(d,p),w=[],x=Math.max(o.width,o.height),O=o.x-x,k=o.x+o.width+x,D=o.y-x,$=o.y+o.height+x;for(let R of tl){let U=[0,0,0];U[R.fixedAxis]=R.fixedSign;let B=M[0]*U[0]+M[1]*U[1]+M[2]*U[2],V=al(qs,Js,B);if(V<Qs)continue;let I=v*V,j={minor:(Ls+Ps*u)*I**Is,major:Ns*I**Ds,frame:Bs*I**Us,axis:(Gs+js*u)*I**Xs},N=[];for(let[z,C]of[[R.axisA,R.axisB],[R.axisB,R.axisA]])for(let F of _)N.push({rule:F,constantAxis:z,runningAxis:C});N.sort((z,C)=>z.rule.rank-C.rule.rank);for(let{rule:z,constantAxis:C,runningAxis:F}of N){let P=[0,0,0],Y=[0,0,0];P[R.fixedAxis]=R.fixedSign*d,Y[R.fixedAxis]=R.fixedSign*d,P[C]=z.coordinate,Y[C]=z.coordinate,P[F]=-d,Y[F]=d;let ue=ot(A,P),ke=ot(A,Y),Ke=To(ue,ke);if(Ke===null)continue;let[Ue,ee]=Ke,xe=Mt(P,Y,Ue),$e=Mt(P,Y,ee),be=b(ot(A,xe)),T=b(ot(A,$e));if(be===null||T===null||be.x<O&&T.x<O||be.x>k&&T.x>k||be.y<D&&T.y<D||be.y>$&&T.y>$)continue;let H=Mt(xe,$e,.5),te=f[el[F]],W=ll({rule:z,strengths:j,lineWidth:g,lineColor:s,axisColor:te,surfaceRgb:n,effectiveOpacity:I});for(let ae of W){let Z=[...H],ne=[...H];Z[C]-=ae.halfWidthWorld,ne[C]+=ae.halfWidthWorld;let we=b(ot(A,Z)),Se=b(ot(A,ne));if(we===null||Se===null)continue;let Oe=Math.hypot(Se.x-we.x,Se.y-we.y);!Number.isFinite(Oe)||Oe<=0||w.push({x1:be.x,y1:be.y,x2:T.x,y2:T.y,widthPx:Oe,color:ae.color})}}}return w.length===0?null:{kind:"grid",segments:w}}a(Vf,"buildReferenceGridModel");function Zf(e,t){if(e===null)return"";if(e.kind==="studio")return vi(e,t);let o=['<g class="cellucid-reference-grid" fill="none" stroke-linecap="butt">'];for(let r of e.segments)o.push(`<line x1="${r.x1.toFixed(2)}" y1="${r.y1.toFixed(2)}" x2="${r.x2.toFixed(2)}" y2="${r.y2.toFixed(2)}" stroke="${r.color}" stroke-width="${r.widthPx.toFixed(3)}"/>`);return o.push("</g>"),o.join("")}a(Zf,"renderSvgReferenceGrid");function qf({ctx:e,model:t}){if(t!==null){if(t.kind==="studio"){Ei({ctx:e,model:t});return}e.save(),e.lineCap="butt";for(let o of t.segments)e.beginPath(),e.moveTo(o.x1,o.y1),e.lineTo(o.x2,o.y2),e.strokeStyle=o.color,e.lineWidth=o.widthPx,e.stroke();e.restore()}}a(qf,"drawCanvasReferenceGrid");var Mi=Object.freeze(["BLEND","CULL_FACE","DEPTH_TEST","DITHER","POLYGON_OFFSET_FILL","RASTERIZER_DISCARD","SAMPLE_ALPHA_TO_COVERAGE","SAMPLE_COVERAGE","SCISSOR_TEST","STENCIL_TEST"]),Ai=Symbol("forget"),_i=new WeakMap;function cl(e){let t=new Map,o=new Set;for(let c of Mi)Number.isInteger(e[c])&&o.add(e[c]);let r=new Map,i=a(()=>{t.clear(),r.clear()},"forget"),n=a((c,l)=>(r.has(c)||r.set(c,l()),r.get(c)),"read"),s=a((c,l)=>{let u=e[c];typeof u=="function"&&(e[c]=a(function(...p){let g=Reflect.apply(u,e,p);return l(...p),g},"shadowedSetter"))},"wrap");return s("enable",c=>{o.has(c)&&t.set(c,!0)}),s("disable",c=>{o.has(c)&&t.set(c,!1)}),s("activeTexture",c=>{r.set("activeTexture",c)}),s("viewport",(c,l,u,d)=>{r.set("viewport",Int32Array.of(c,l,u,d))}),s("scissor",(c,l,u,d)=>{r.set("scissorBox",Int32Array.of(c,l,u,d))}),s("colorMask",(c,l,u,d)=>{r.set("colorMask",[!!c,!!l,!!u,!!d])}),s("clearColor",(c,l,u,d)=>{r.set("clearColor",[Math.fround(c),Math.fround(l),Math.fround(u),Math.fround(d)])}),s("blendFunc",(c,l)=>{r.set("blendFunc",{srcRgb:c,dstRgb:l,srcAlpha:c,dstAlpha:l})}),s("blendFuncSeparate",(c,l,u,d)=>{r.set("blendFunc",{srcRgb:c,dstRgb:l,srcAlpha:u,dstAlpha:d})}),s("blendEquation",c=>{r.set("blendEquation",{rgb:c,alpha:c})}),s("blendEquationSeparate",(c,l)=>{r.set("blendEquation",{rgb:c,alpha:l})}),s("depthMask",c=>{r.set("depthMask",!!c)}),s("vertexAttrib4f",(c,l,u,d,p)=>{r.set(`generic${c}`,Float32Array.of(l,u,d,p))}),s("vertexAttribI4i",(c,l,u,d,p)=>{r.set(`generic${c}`,Int32Array.of(l,u,d,p))}),s("vertexAttribI4ui",(c,l,u,d,p)=>{r.set(`generic${c}`,Uint32Array.of(l,u,d,p))}),Object.freeze({[Ai]:i,isEnabled(c){if(!o.has(c))throw new RangeError(`The WebGL state shadow does not track capability 0x${Number(c).toString(16)}.`);return t.has(c)||t.set(c,e.isEnabled(c)===!0),t.get(c)},get activeTexture(){return n("activeTexture",()=>e.getParameter(e.ACTIVE_TEXTURE))},get viewport(){return Int32Array.from(n("viewport",()=>Int32Array.from(e.getParameter(e.VIEWPORT))))},get scissorBox(){return Int32Array.from(n("scissorBox",()=>Int32Array.from(e.getParameter(e.SCISSOR_BOX))))},get colorMask(){return[...n("colorMask",()=>Array.from(e.getParameter(e.COLOR_WRITEMASK),Boolean))]},get clearColor(){return[...n("clearColor",()=>Array.from(e.getParameter(e.COLOR_CLEAR_VALUE)))]},get blendFunc(){return{...n("blendFunc",()=>({srcRgb:e.getParameter(e.BLEND_SRC_RGB),dstRgb:e.getParameter(e.BLEND_DST_RGB),srcAlpha:e.getParameter(e.BLEND_SRC_ALPHA),dstAlpha:e.getParameter(e.BLEND_DST_ALPHA)}))}},get blendEquation(){return{...n("blendEquation",()=>({rgb:e.getParameter(e.BLEND_EQUATION_RGB),alpha:e.getParameter(e.BLEND_EQUATION_ALPHA)}))}},get depthMask(){return n("depthMask",()=>e.getParameter(e.DEPTH_WRITEMASK)===!0)},genericAttribute(c){let l=r.get(`generic${c}`)??Float32Array.of(0,0,0,1);return new l.constructor(l)}})}a(cl,"createShadow");function eu(e){let t=gr(e);t[Ai]();for(let o of Mi)Number.isInteger(e[o])&&t.isEnabled(e[o]);for(let o of["activeTexture","viewport","scissorBox","colorMask","clearColor","blendFunc","blendEquation","depthMask"])t[o]}a(eu,"primeGlState");function gr(e){let t=_i.get(e);return t===void 0&&(t=cl(e),_i.set(e,t)),t}a(gr,"glStateOf");var $t=`#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform vec4 u_ndcTransform;
out vec2 v_ndc;
void main() {
  v_ndc = a_corner * u_ndcTransform.xy + u_ndcTransform.zw;
  gl_Position = vec4(a_corner, 1.0, 1.0);
}
`,Ti=`
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
`,Si=`
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
`,ki=`
// x: present (0/1), y: magnitude 0..1, z: color temperature 0..1; dir out.
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
`,wr=`#version 300 es
precision highp float;
uniform int u_face;      // cube face 0..5, or -1 for the periodic tile
uniform float u_size;    // texels per side
out vec4 fragColor;
${Ti}
${Si}
${ki}
`,fl=`${wr}
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
`,ul=`${wr}
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
`,dl=`${wr}
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
`,Po=`#version 300 es
precision highp float;
in vec2 v_ndc;
uniform mat4 u_invMvp;        // pane NDC -> model space
uniform vec3 u_eye;           // camera, model space
uniform float u_pixelRatio;   // device px per CSS px
uniform vec2 u_viewport;      // pane size, device px
uniform float u_glowCenterX;  // NDC x of the presented area's centre
uniform float u_opacity;      // fade-in 0..1
uniform vec3 u_surface;       // clear color (sRGB)
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
${Ti}
${Si}
${ki}

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
`,hl=`${Po}
uniform samplerCube u_sky;
uniform sampler2D u_tile;

const vec3 BAND_NORMAL = vec3(0.3283, 0.8536, -0.4048);
const vec3 DEEP = vec3(0.0011, 0.0013, 0.0034);
const vec3 BAND_LIFT = vec3(0.0042, 0.0040, 0.0062);

// Data tints graded toward the classic emission palette (H-alpha rose,
// O-III teal), so a field of warm colors never turns the sky to mud.
vec3 grade(vec3 tint, vec3 cosmic) {
  vec3 t = mix(tint, cosmic, 0.5);
  return t / max(luma(t), 1e-3);
}

// detail: fine fBm evaluated per fragment, finer than the cube's texels, so
// the clouds stay crisp at 4K and DPR 2 (-1..1, faded out where it would alias).
vec3 nebulaColor(vec4 s, float band, float detail) {
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
    col = nebulaColor(s, band, nebulaDetail(d, pixelAngle));
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
    col = nebulaColor(s, band, nebulaDetail(d, skyPixel));
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
`,pl=`${Po}
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
    // horizon with no edge; both meet the same horizon color.
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
      vec3 lightColor = mix(FILL, KEY, 0.55 + 0.45 * side);
      vec3 floorColor = PAPER * lightColor * (0.86 + 0.08 * wide + 0.12 * pool);
      floorColor = applyShadow(floorColor, shadowAt(uv));
      floorColor *= 1.0 + 0.010 * grain;
      // The cove: the floor blends into the horizon color as it nears
      // grazing, so floor and wall meet without an edge.
      float cove = 1.0 - smoothstep(0.0, 0.30, -rise);
      col = mix(floorColor, horizon, cove);
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
`,ml=`${Po}
uniform samplerCube u_sky;     // r: broad shafts, g: caustics, b: murk, a: fine shafts
uniform sampler2D u_tile;      // r: murk, g: caustics (periodic)

const vec3 SUN = vec3(0.2357, 0.9428, 0.2357);
const float DIP = 0.55;

vec3 water(vec3 d, vec4 s, float planarMurk) {
  float rise = d.y;
  vec3 top, horizon, depth, shaftColor, causticColor;
  if (u_dark > 0.5) {
    top = vec3(0.012, 0.050, 0.068);
    horizon = vec3(0.0035, 0.0160, 0.0250);
    depth = vec3(0.0005, 0.0018, 0.0036);
    shaftColor = vec3(0.020, 0.080, 0.085);
    causticColor = vec3(0.012, 0.050, 0.050);
  } else {
    top = vec3(0.90, 0.98, 0.96);
    horizon = vec3(0.56, 0.81, 0.83);
    depth = vec3(0.40, 0.69, 0.74);
    shaftColor = vec3(0.36, 0.28, 0.18);
    causticColor = vec3(0.20, 0.17, 0.12);
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
    col += shaftColor * shafts;
    col += causticColor * s.g;
    col += shaftColor * 0.7 * sunGlow;
    col = kneeLuminance(col, 0.046);
  } else {
    col += shaftColor * shafts * 0.40;
    col += causticColor * s.g * 0.8;
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
vec3 sandFloor(vec2 uv, float distance, vec3 waterColor) {
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
  return mix(lit, waterColor, clamp(fog, 0.0, 1.0));
}

vec3 seaFloor(vec3 ray, vec3 waterColor) {
  // The sand lies under the stage, and sinks under a camera that dives
  // below the data, so there is always a sea floor beneath the viewer.
  float floorY = min(u_floorY - 1.2, u_eye.y - 1.2);
  if (u_dark > 0.5 || ray.y >= -0.01) return waterColor;
  float t = (floorY - u_eye.y) / ray.y;
  vec2 uv = (u_eye + ray * t).xz;
  return sandFloor(uv, t, waterColor);
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
`,yl=`${Po}
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
    vec3 litColor = mix(vec3(1.0, 0.96, 0.97), vec3(1.0, 0.85, 0.70), sunSide * sunSide);
    vec3 shadeColor = vec3(0.62, 0.62, 0.80);
    vec3 cloud = mix(shadeColor, litColor, smoothstep(0.15, 0.85, s.g));
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
    vec3 skyColor = sky(d, s, pixelAngle, behind);
    if (d.y >= 0.0) {
      col = skyColor;
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
`,bl=`#version 300 es
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
`,xl=`#version 300 es
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
`,Ri=Object.freeze({"bake:nebula":Object.freeze({vs:$t,fs:fl}),"bake:abyss":Object.freeze({vs:$t,fs:ul}),"bake:aurora":Object.freeze({vs:$t,fs:dl}),"draw:nebula":Object.freeze({vs:$t,fs:hl}),"draw:atelier":Object.freeze({vs:$t,fs:pl}),"draw:abyss":Object.freeze({vs:$t,fs:ml}),"draw:aurora":Object.freeze({vs:$t,fs:yl}),"draw:motes":Object.freeze({vs:bl,fs:xl})});var gl="(prefers-reduced-motion: reduce)",vr=null;function $i(){if(vr!==null)return vr;if(typeof globalThis.matchMedia!="function")return null;let e=globalThis.matchMedia(gl);if(e===null||typeof e!="object"||typeof e.matches!="boolean")throw new TypeError("Reduced-motion preference requires an exact MediaQueryList.");return vr=e,e}a($i,"preferenceMedia");function nu(){return $i()?.matches??!1}a(nu,"prefersReducedMotion");function Fi(e){if(typeof e!="function")throw new TypeError("A reduced-motion listener must be a function.");let t=$i();if(t===null)return()=>{};if(typeof t.addEventListener!="function"||typeof t.removeEventListener!="function")throw new TypeError("Reduced-motion preference requires a MediaQueryList that announces changes.");let o=a(()=>e(t.matches),"onChange");return t.addEventListener("change",o),()=>t.removeEventListener("change",o)}a(Fi,"onReducedMotionChange");var Er=9,Io=10,Kt=11,vl=Object.freeze([1,1,0,0]),El=8,_r=Symbol("wait"),zi=131072,_l=1024,Ml=128,Al=16,Tl=2e3,Tt=512,Mr=3200,Ci=Object.freeze({nebula:{bake:"bake:nebula",draw:"draw:nebula",cube:"byte",tile:!0},atelier:{bake:null,draw:"draw:atelier",cube:null,tile:!1},abyss:{bake:"bake:abyss",draw:"draw:abyss",cube:"byte",tile:!0,motes:!0},aurora:{bake:"bake:aurora",draw:"draw:aurora",cube:"byte",tile:!0}});function No(e){let t=No.f32??=new Float32Array(1),o=No.u32??=new Uint32Array(t.buffer);t[0]=e;let r=o[0],i=r>>>16&32768,n=(r>>>23&255)-127+15,s=r&8388607;if(n<=0)return n<-10?i:(s=(s|8388608)>>1-n,i|s+4096>>13);if(n>=31)return i|31744;let f=s+4096;return f&8388608?(n+=1,n>=31?i|31744:i|n<<10):i|n<<10|f>>13}a(No,"halfFromFloat");var Li=64;function*Ar(e,t,o,r,i){if(o<1)return;let n=o*2+1;for(let s=0;s<r;s++){for(let f=0;f<t;f++){let c=f*t,l=0;for(let u=-o;u<=o;u++)l+=e[c+Math.min(t-1,Math.max(0,u))];for(let u=0;u<t;u++){i[c+u]=l/n;let d=Math.min(t-1,u+o+1),p=Math.max(0,u-o);l+=e[c+d]-e[c+p]}(f+1)%Li===0&&(yield)}for(let f=0;f<t;f++){let c=0;for(let l=-o;l<=o;l++)c+=i[Math.min(t-1,Math.max(0,l))*t+f];for(let l=0;l<t;l++){e[l*t+f]=c/n;let u=Math.min(t-1,l+o+1),d=Math.max(0,l-o);c+=i[u*t+f]-i[d*t+f]}(f+1)%Li===0&&(yield)}}}a(Ar,"boxBlur");function Sl(e){if(!(e instanceof Uint8Array))return 0;let t=new Uint32Array(e.buffer,e.byteOffset,e.byteLength>>>2),o=2166136261^e.length;for(let r=0;r<t.length;r++)o=Math.imul(o^t[r],16777619);for(let r=t.length*4;r<e.length;r++)o=Math.imul(o^e[r],16777619);return o>>>0}a(Sl,"visibilitySignature");function Pi(e,{invalidate:t,requestFrame:o,prefersReducedMotion:r,readViewSource:i}){let n=a(()=>performance.now(),"now"),s=e.getExtension("KHR_parallel_shader_compile"),f=Math.min(64,e.getParameter(e.ALIASED_POINT_SIZE_RANGE)[1]||64),c=!1,l=null,u=0,d=1,p=!1,g=null,v=0,A=0,y=!1,b=0,M=new Map,_=new Map,w=new Map,x=[],O=[],k=null,D=null,$={slices:0,maxSliceMs:0,totalMs:0};function R(){k!==null||c||(typeof requestIdleCallback=="function"?(D="idle",k=requestIdleCallback(B,{timeout:120})):(D="timeout",k=setTimeout(B,4)))}a(R,"scheduleSlice");function U(){k!==null&&(D==="idle"?cancelIdleCallback(k):clearTimeout(k),k=null)}a(U,"cancelSlice");function B(){if(k=null,c||x.length===0)return;let h=n(),m=!1;for(;x.length>0;){let S=x[0],X=n(),K;try{K=S.iterator.next()}catch(Te){x.shift(),console.error(`[backdrop-looks] ${S.name} failed:`,Te);continue}let ie=n()-X;if(S.cpuMs+=ie,S.units+=1,ie>S.maxUnitMs&&(S.maxUnitMs=ie,S.maxUnitStage=S.stage),!K.done&&K.value===_r){m=!0;break}if(K.done&&(x.shift(),S.doneAt=n(),O.push({name:S.name,units:S.units,cpuMs:+S.cpuMs.toFixed(2),maxUnitMs:+S.maxUnitMs.toFixed(2),maxUnitStage:S.maxUnitStage,wallMs:+(S.doneAt-S.startedAt).toFixed(1)}),O.length>40&&O.shift()),n()-h>=El)break}let E=n()-h;$.slices+=1,$.totalMs+=E,$.maxSliceMs=Math.max($.maxSliceMs,E),x.length>0&&(m?(D="timeout",k=setTimeout(B,1)):R())}a(B,"runSlice");function V(h,m,E=!1){let S={name:h,iterator:null,cpuMs:0,units:0,maxUnitMs:0,maxUnitStage:null,stage:"start",startedAt:n(),doneAt:null,cancelled:!1};return S.iterator=m(S),E?x.unshift(S):x.push(S),R(),S}a(V,"enqueue");function I(h){if(h==null)return;h.cancelled=!0;let m=x.indexOf(h);m>=0&&x.splice(m,1)}a(I,"cancelJob");let j=e.createVertexArray(),N=e.createBuffer();e.bindVertexArray(j),e.bindBuffer(e.ARRAY_BUFFER,N),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null);let z=null,C=null;function F(){if(z!==null)return;let h=new Float32Array(Mr*4),m=1234567,E=a(()=>(m=Math.imul(m^m>>>15,2246822507)^Math.imul(m^m>>>13,3266489909),m^=m>>>16,(m>>>0)/4294967296),"random");for(let S=0;S<Mr;S++)h[S*4]=E()*2-1,h[S*4+1]=E()*2-1,h[S*4+2]=E()*2-1,h[S*4+3]=E();z=e.createVertexArray(),C=e.createBuffer(),e.bindVertexArray(z),e.bindBuffer(e.ARRAY_BUFFER,C),e.bufferData(e.ARRAY_BUFFER,h,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,4,e.FLOAT,!1,0,0),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null),b+=h.byteLength}a(F,"ensureMotes");let P=gr(e);function Y(){return{framebuffer:e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),viewport:P.viewport,program:e.getParameter(e.CURRENT_PROGRAM),vao:e.getParameter(e.VERTEX_ARRAY_BINDING),blend:P.isEnabled(e.BLEND),depth:P.isEnabled(e.DEPTH_TEST),scissor:P.isEnabled(e.SCISSOR_TEST),scissorBox:P.scissorBox,cull:P.isEnabled(e.CULL_FACE),activeTexture:P.activeTexture}}a(Y,"saveState");function ue(h){e.bindFramebuffer(e.DRAW_FRAMEBUFFER,h.framebuffer),e.viewport(h.viewport[0],h.viewport[1],h.viewport[2],h.viewport[3]),e.useProgram(h.program),e.bindVertexArray(h.vao),(h.blend?e.enable:e.disable).call(e,e.BLEND),(h.depth?e.enable:e.disable).call(e,e.DEPTH_TEST),(h.scissor?e.enable:e.disable).call(e,e.SCISSOR_TEST),e.scissor(h.scissorBox[0],h.scissorBox[1],h.scissorBox[2],h.scissorBox[3]),(h.cull?e.enable:e.disable).call(e,e.CULL_FACE),e.activeTexture(h.activeTexture)}a(ue,"restoreState");function ke(h){let m=M.get(h);if(m)return m;let E=Ri[h],S=e.createShader(e.VERTEX_SHADER);e.shaderSource(S,E.vs),e.compileShader(S);let X=e.createShader(e.FRAGMENT_SHADER);e.shaderSource(X,E.fs),e.compileShader(X);let K=e.createProgram();return e.attachShader(K,S),e.attachShader(K,X),e.bindAttribLocation(K,0,h==="draw:motes"?"a_seed":"a_corner"),e.linkProgram(K),m={key:h,program:K,vs:S,fs:X,ready:!1,failed:!1,uniforms:new Map,startedAt:n(),readyAt:0},M.set(h,m),m}a(ke,"startProgram");function Ke(h){if(h.ready||h.failed)return!0;if(s&&!e.getProgramParameter(h.program,s.COMPLETION_STATUS_KHR))return!1;if(!e.getProgramParameter(h.program,e.LINK_STATUS))return h.failed=!0,console.error(`[backdrop-looks] ${h.key} failed to link:`,e.getProgramInfoLog(h.program),e.getShaderInfoLog(h.vs),e.getShaderInfoLog(h.fs)),!0;let m=e.getProgramParameter(h.program,e.ACTIVE_UNIFORMS);for(let E=0;E<m;E++){let S=e.getActiveUniform(h.program,E),X=S.name.replace(/\[0\]$/,"");h.uniforms.set(X,e.getUniformLocation(h.program,S.name))}return h.ready=!0,h.readyAt=n(),!0}a(Ke,"pollProgram");function*Ue(h){let m=h.map(ke);for(;!m.every(Ke);)yield _r;return m}a(Ue,"awaitPrograms");function ee(h,m){let E=e.createTexture();return e.activeTexture(e.TEXTURE0+m),e.bindTexture(h,E),E}a(ee,"createTexture");function xe(h){let m=_.get(h);return m||(m={family:h,cube:null,cubeSize:0,candidateCube:null,tile:null,ready:!1,job:null,framebuffer:null,stats:null},_.set(h,m)),m}a(xe,"familyState");function*$e(h,m,E){let S=m;for(E.stage="band-wait";;){let X=Br(e,h),K=n();if(X)return e.deleteSync(h),E.stage="bands",S-m+(K-S)/2;S=K,yield _r}}a($e,"awaitFence");function*be(h,m,E,S,X,K,ie,Te){for(let L=0;L<X;L+=K){if(ie.cancelled)return!1;let Fe=Math.min(K,X-L),ze=n(),_e=Y();e.bindFramebuffer(e.DRAW_FRAMEBUFFER,h.framebuffer),E>=0?e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_CUBE_MAP_POSITIVE_X+E,S,0):e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,S,0),e.viewport(0,0,X,X),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.disable(e.CULL_FACE),e.enable(e.SCISSOR_TEST),e.scissor(0,L,X,Fe),e.useProgram(m.program),e.uniform1i(m.uniforms.get("u_face"),E),e.uniform1f(m.uniforms.get("u_size"),X),e.bindVertexArray(j),e.drawArrays(e.TRIANGLES,0,3),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,null,0),E<0&&L+Fe>=X&&(e.activeTexture(e.TEXTURE0+Io),e.bindTexture(e.TEXTURE_2D,S),e.generateMipmap(e.TEXTURE_2D));let ct=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0);e.flush(),ue(_e),Te.issueMs+=n()-ze;let Ge=yield*$e(ct,ze,ie);Te.gpuMs+=Ge,Te.maxBandMs=Math.max(Te.maxBandMs,Ge),Te.texels+=X*Fe,Te.bands+=1}return!0}a(be,"bakeTarget");function T(h,m){let E=m===null?zi:Math.min(zi,Al/m);return Math.max(1,Math.min(h,Math.floor(E/h)))}a(T,"rowsPerBandFor");function H(h){let m=ee(e.TEXTURE_CUBE_MAP,Er);return e.texStorage2D(e.TEXTURE_CUBE_MAP,1,e.RGBA8,h,h),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),m}a(H,"createCube");function*te(h,m){let E=Ci[h],S=xe(h),X={family:h,startedAt:m.startedAt,programsReadyMs:0,levels:[],cubeSize:0,texelRateMs:null,readyMs:0,wallMs:0,cpuMs:0,bytes:0};S.stats=X;let K=[E.draw];E.bake&&K.push(E.bake),E.motes&&K.push("draw:motes"),m.stage="compile";let ie=yield*Ue(K);if(m.stage="allocate",X.programsReadyMs=n()-m.startedAt,!ie.some(Te=>Te.failed)){if(E.motes&&F(),E.bake){let Te=M.get(E.bake),L=Math.round(Tt*Tt*4*4/3),Fe=a(Ae=>({size:Ae,bands:0,gpuMs:0,maxBandMs:0,issueMs:0,texels:0,wallMs:0}),"newLevel"),ze=null;S.framebuffer??=e.createFramebuffer();let _e=Ml,ct=Y(),Ge=H(_e);ue(ct),yield,m.stage="bands";let je=Fe(_e),Xe=n();for(let Ae=0;Ae<6;Ae++)if(!(yield*be(S,Te,Ae,Ge,_e,T(_e,ze),m,je))){Qe(e,Ge);return}je.wallMs=n()-Xe,X.levels.push(je),ze=je.gpuMs/je.texels,X.texelRateMs=ze,S.cube=Ge,S.cubeSize=_e,X.cubeSize=_e,X.bytes=_e*_e*6*4+L,b+=X.bytes;let ft=Y();S.tile=ee(e.TEXTURE_2D,Io),e.texStorage2D(e.TEXTURE_2D,Math.log2(Tt)+1,e.RGBA8,Tt,Tt),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.REPEAT),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.REPEAT),ue(ft),yield;let nt=Fe(Tt),at=n();if(!(yield*be(S,Te,-1,S.tile,Tt,T(Tt,ze),m,nt)))return;for(nt.wallMs=n()-at,X.tile=nt,X.readyMs=n()-m.startedAt,S.ready=!0,d+=1,t(),ne();_e<_l;){let Ae=_e*2;if(ze*Ae*Ae*6>Tl)break;let io=Y();Ge=H(Ae),ue(io),S.candidateCube=Ge,yield,je=Fe(Ae);let Wt=n(),ut=!0;for(let Ot=0;Ot<6&&ut;Ot++)ut=yield*be(S,Te,Ot,Ge,Ae,T(Ae,ze),m,je);if(!ut){Qe(e,Ge),S.candidateCube=null;return}je.wallMs=n()-Wt,X.levels.push(je),ze=je.gpuMs/je.texels,X.texelRateMs=ze,Qe(e,S.cube),S.cube=Ge,S.candidateCube=null,b+=Ae*Ae*6*4-_e*_e*6*4,X.bytes+=Ae*Ae*6*4-_e*_e*6*4,_e=Ae,S.cubeSize=_e,X.cubeSize=_e,d+=1,t()}X.wallMs=n()-m.startedAt,X.cpuMs=m.cpuMs,S.job=null;return}X.wallMs=n()-m.startedAt,X.cpuMs=m.cpuMs,S.ready=!0,S.job=null,d+=1,t(),ne()}}a(te,"bakeFamily");function W(h){let m=xe(h);return m.ready||m.job!==null||(m.job=V(`bake ${h}`,E=>te(h,E),!0)),m}a(W,"ensureFamily");function ae(h){for(let[m,E]of _)m!==h&&(I(E.job),E.job=null,(E.cube||E.tile)&&(b-=E.stats?.bytes??0),E.cube&&Qe(e,E.cube),E.candidateCube&&Qe(e,E.candidateCube),E.tile&&Qe(e,E.tile),E.framebuffer&&e.deleteFramebuffer(E.framebuffer),E.cube=null,E.cubeSize=0,E.candidateCube=null,E.tile=null,E.framebuffer=null,E.ready=!1)}a(ae,"evictFamiliesExcept");let Z=new Set;function ne(){for(let h of[...Z])h.check()&&(Z.delete(h),h.resolve())}a(ne,"notifyReady");function we(h){let m=w.get(h);return m||(m={generation:-1,tints:null,tintLook:null,tintJob:null,shadowKey:null,checkedKey:null,shadowJob:null,shadowTexture:null,shadowSpare:null,shadowPacked:null,shadowWindow:[0,0,1],shadowStats:null},w.set(h,m)),m}a(we,"paneState");function Se(h){return h.defaultTints.map(m=>er(m,.85))}a(Se,"lookTintsLinear");function*Oe(h,m,E,S){let X=we(h),K=Se(E);if(m!==null&&m.colors instanceof Uint8Array&&m.colors.length>0){let ie=vn(m.colors,m.visibility,3,65536);if(yield,S.cancelled)return;if(ie.colors.length>0){let Te=E.tone==="dark"?.8:.6;K=[0,1,2].map(L=>er(ie.colors[Math.min(L,ie.colors.length-1)],Te))}}X.tints=K,X.tintLook=E.id,X.tintJob=null,ne(),d+=1,t()}a(Oe,"computeTints");function me(h,m){return h.tints===null||h.tintLook!==m.id?null:h.tints}a(me,"currentTints");function*Ee(h,m,E,S,X,K){let ie=we(h),Te=n(),L=Jt;K.stage="shadow-allocate";let Fe=new Float32Array(L*L),ze=new Float32Array(L*L),_e=new Float32Array(L*L),ct=new Float32Array(L*L),{positions:Ge,dimension:je,visibility:Xe}=m,ft=Math.floor(Ge.length/je),nt,at,re,Ae,Ft,io=0,Wt=S?Math.max(E.extentZ*2+Qt,Qt):Math.max(E.extentY*2+.12,.12);if(S){let pe=[-.45,.55,.7];Ae=-pe[0]/pe[2],Ft=-pe[1]/pe[2],io=E.stageZ-E.extentZ-Qt,nt=E.stageX,at=E.centerY,re=Math.max(E.extentX,E.extentY)*1.3+Wt*.8+.3}else{Ae=-Dt[0]/Dt[1],Ft=-Dt[2]/Dt[1],nt=E.stageX,at=E.stageZ;let pe=Wt*Math.hypot(Ae,Ft);re=Math.max(E.extentX,E.extentZ)*1.25+pe*.6+.35}let ut=L/(2*re),Ot=nt-re,Sr=at-re,ao=Math.max(1,Math.floor(ft/2e6)),kr=4e4,Rr=0;K.stage="shadow-splat";for(let pe=0;pe<ft;pe+=kr*ao){let tt=Math.min(ft,pe+kr*ao);for(let Ve=pe;Ve<tt;Ve+=ao){let mt=Xe===null||Xe[Ve]!==0?1:0;if(mt<=0)continue;let zt=Ve*je,Ze=Ge[zt],Ht=je>1?Ge[zt+1]:0,Fr=je>2?Ge[zt+2]:0,Or,zr,Vt,co,fo;S?(Vt=Fr-io,co=Ze,fo=Ht):(Vt=Ht-E.floorY,co=Ze,fo=Fr),Or=co+Ae*Vt,zr=fo+Ft*Vt,Rr+=mt;let Uo=Math.min(1,Math.max(0,Vt/Wt)),uo=(Or-Ot)*ut-.5,ho=(zr-Sr)*ut-.5,yt=Math.floor(uo),bt=Math.floor(ho);if(yt>=0&&bt>=0&&yt<L-1&&bt<L-1){let po=uo-yt,mo=ho-bt,xt=bt*L+yt,yo=mt*(1-Uo),bo=mt*Uo,Cr=(1-po)*(1-mo),Lr=po*(1-mo),Pr=(1-po)*mo,Ir=po*mo;Fe[xt]+=yo*Cr,Fe[xt+1]+=yo*Lr,Fe[xt+L]+=yo*Pr,Fe[xt+L+1]+=yo*Ir,ze[xt]+=bo*Cr,ze[xt+1]+=bo*Lr,ze[xt+L]+=bo*Pr,ze[xt+L+1]+=bo*Ir}uo=(co-Ot)*ut,ho=(fo-Sr)*ut,yt=uo|0,bt=ho|0,yt>=0&&bt>=0&&yt<L&&bt<L&&(_e[bt*L+yt]+=mt*Math.exp(-Uo*2.2))}if(yield,K.cancelled)return}let Bo=ut,Gi=Math.max(1,Math.round(Bo*.035)),ji=Math.max(2,Math.round(Bo*.11)),Xi=Math.max(3,Math.round(Bo*.16));if(K.stage="shadow-blur",yield*Ar(Fe,L,Gi,3,ct),K.cancelled||(yield*Ar(ze,L,ji,3,ct),K.cancelled)||(yield*Ar(_e,L,Xi,3,ct),K.cancelled))return;let $r=a(pe=>{let tt=0;for(let Ze=0;Ze<pe.length;Ze++)pe[Ze]>tt&&(tt=pe[Ze]);if(!(tt>0))return 1;let Ve=new Uint32Array(1024),mt=0;for(let Ze=0;Ze<pe.length;Ze++){let Ht=pe[Ze];Ht>0&&(Ve[Math.min(1023,Math.floor(Ht/tt*1024))]+=1,mt+=1)}let zt=mt*.97;for(let Ze=0;Ze<1024;Ze++)if(zt-=Ve[Ze],zt<=0)return(Ze+1)/1024*tt;return tt},"percentile");for(let pe=0;pe<Fe.length;pe++)Fe[pe]+=ze[pe]*.8;K.stage="shadow-normalise";let Ki=$r(Fe);yield;let Wi=$r(_e);yield;let so=new Uint16Array(L*L*2),lo=64;K.stage="shadow-pack";for(let pe=0;pe<L;pe+=lo){let tt=Math.min(L,pe+lo)*L;for(let Ve=pe*L;Ve<tt;Ve++)so[Ve*2]=No(1-Math.exp(-1.4*Fe[Ve]/Ki)),so[Ve*2+1]=No(1-Math.exp(-1.2*_e[Ve]/Wi));if(yield,K.cancelled)return}if(K.cancelled)return;K.stage="shadow-upload";let Yt=ie.shadowSpare;if(Yt===null){let pe=Y();Yt=ee(e.TEXTURE_2D,Kt),e.texStorage2D(e.TEXTURE_2D,1,e.RG16F,L,L),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),ue(pe),b+=L*L*4,ie.shadowSpare=Yt,yield}for(let pe=0;pe<L;pe+=lo){if(K.cancelled)return;let tt=Math.min(lo,L-pe),Ve=Y();e.activeTexture(e.TEXTURE0+Kt),e.bindTexture(e.TEXTURE_2D,Yt),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texSubImage2D(e.TEXTURE_2D,0,0,pe,L,tt,e.RG,e.HALF_FLOAT,so.subarray(pe*L*2,(pe+tt)*L*2)),ue(Ve),yield}K.cancelled||(ie.shadowSpare=ie.shadowTexture,ie.shadowTexture=Yt,ie.shadowWindow=[nt,at,re],ie.shadowPacked=so,ie.shadowKey=X,ne(),ie.shadowJob=null,ie.shadowStats={points:ft,visible:Math.round(Rr),stride:ao,wallMs:n()-Te,cpuMs:K.cpuMs},d+=1,t())}a(Ee,"bakeShadow");function Le(h,m,E,S){let X=we(h),K=i(h),ie=K===null?0:K.generation;if((ie!==X.generation||X.tintLook!==m.id)&&X.tintJob===null&&(X.generation=ie,X.tintJob=V(`tints ${h}`,Te=>Oe(h,K,m,Te))),m.family==="atelier"&&m.program==="atelier"&&K!==null&&K.positions.length>0){X.positionsRef!==K.positions&&(X.positionsRef=K.positions,X.positionsEpoch=(X.positionsEpoch??0)+1);let Te=[X.positionsEpoch,K.positions.length,K.dimension,S?1:0,E.floorY.toFixed(5),E.stageX.toFixed(5),E.stageZ.toFixed(5)].join("|"),L=`${Te}|${ie}`;if(L!==X.checkedKey){X.checkedKey=L,I(X.shadowJob);let Fe={...E};X.shadowJob=V(`shadow ${h}`,function*(ze){ze.stage="shadow-signature";let _e=`${Te}|${Sl(K.visibility)}`;if(yield,!ze.cancelled){if(_e===X.shadowKey){X.shadowJob=null;return}yield*Ee(h,K,Fe,S,_e,ze)}})}}return X}a(Le,"syncPane");function Pe(){return p&&l!==null&&!r()&&(typeof document>"u"||document.visibilityState!=="hidden")&&(l==="nebula"||l==="aurora-dark"||l.startsWith("abyss"))}a(Pe,"ambientWanted");function Me(){if(g=null,!Pe())return;let h=n();v+=Math.min(.1,(h-A)/1e3),A=h,d+=1,y=!0,o(),g=setTimeout(Me,1e3/30)}a(Me,"tickAmbient");function ye(){Pe()?g===null&&(A=n(),g=setTimeout(Me,1e3/30)):g!==null&&(clearTimeout(g),g=null)}a(ye,"syncAmbient");let G=a(()=>ye(),"onVisibility");typeof document<"u"&&document.addEventListener("visibilitychange",G);let Q=Fi(a(()=>{ye(),r()&&u<1&&oe()&&(u=1,d+=1,t())},"onReducedMotion"));function q(h){let m=h===null?null:h;if(m!==null&&!Nt(m))throw new TypeError(`Unknown backdrop look "${h}".`);if(m===l)return;let E=l===null?null:ht[l].program;if(l=m,d+=1,m!==null){let S=ht[m].program;ae(S),u=W(S).ready&&E===S?1:0}else ae(null),u=0;ye()}a(q,"setLook");function oe(){if(l===null)return!1;let h=_.get(ht[l].program);return h!==void 0&&h.ready}a(oe,"isLookReady");function ge(h){y=!1,l!==null&&oe()&&u<1&&(u=r()?1:Math.min(1,u+h/.35),d+=1)}a(ge,"advance");function rt(){return l===null?null:oe()&&u<1?"backdrop-fade":null}a(rt,"frameCause");function Ce(){return y&&g!==null?"backdrop-motion":null}a(Ce,"motionCause");function de(h,m,E){let S=h.uniforms.get(m);S!==void 0&&e.uniform3f(S,E[0],E[1],E[2])}a(de,"setUniform3");function se(h,m,E){let S=h.uniforms.get(m);S!==void 0&&e.uniform1f(S,E)}a(se,"setUniform1");function le(h,m,E){let S=h.uniforms.get(m);S!==void 0&&e.uniform4f(S,E[0],E[1],E[2],E[3])}a(le,"setUniform4");let he=null,ve=null;function Ie(h){return h===null?{texture:null,window:[0,0,1],ready:!1}:(ve!==h.packed&&(he===null?(he=ee(e.TEXTURE_2D,Kt),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE)):(e.activeTexture(e.TEXTURE0+Kt),e.bindTexture(e.TEXTURE_2D,he)),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texImage2D(e.TEXTURE_2D,0,e.RG16F,h.size,h.size,0,e.RG,e.HALF_FLOAT,h.packed),ve=h.packed),{texture:he,window:h.window,ready:!0})}a(Ie,"frozenShadow");let Be=[[0,0,0],[0,0,0],[0,0,0]];function lt(h){if(c||l===null)return!1;let m=ht[l],E=m.program,S=_.get(E),X=Ci[E],K=h.frozen??null,ie=K===null?Le(h.viewId,m,h.geometry,h.planar===1):null,Te=K===null?u:1;if(!S||!S.ready||Te<=0)return!1;let L=M.get(X.draw);if(!L||!L.ready)return!1;let Fe=h.ndcTransform??vl,ze=K===null?v:K.time,_e=K!==null?K.tints:me(ie,m)??Se(m);for(let re=0;re<3;re++)Be[re][0]=_e[re][0],Be[re][1]=_e[re][1],Be[re][2]=_e[re][2];let ct=P.isEnabled(e.BLEND),Ge=P.isEnabled(e.DEPTH_TEST),je=P.activeTexture,Xe=h.geometry;e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.depthMask(!1),e.useProgram(L.program),e.uniformMatrix4fv(L.uniforms.get("u_invMvp"),!1,h.invMvp),e.uniform3f(L.uniforms.get("u_eye"),h.eye[0],h.eye[1],h.eye[2]),se(L,"u_pixelRatio",h.pixelRatio);let ft=L.uniforms.get("u_viewport");ft!==void 0&&e.uniform2f(ft,h.viewportWidth,h.viewportHeight),se(L,"u_glowCenterX",h.glowCenterX),se(L,"u_opacity",Te),le(L,"u_ndcTransform",Fe);let nt=m.surface;if(de(L,"u_surface",[nt[0]/255,nt[1]/255,nt[2]/255]),se(L,"u_planar",h.planar),de(L,"u_stageCenter",[Xe.stageX,Xe.centerY,Xe.stageZ]),de(L,"u_stageExtent",[Xe.extentX,Xe.extentY,Xe.extentZ]),se(L,"u_floorY",Xe.floorY),se(L,"u_time",ze),se(L,"u_ambient",K===null?g!==null?1:0:K.ambient),se(L,"u_dark",m.tone==="dark"?1:0),de(L,"u_tint0",Be[0]),de(L,"u_tint1",Be[1]),de(L,"u_tint2",Be[2]),S.cube){e.activeTexture(e.TEXTURE0+Er),e.bindTexture(e.TEXTURE_CUBE_MAP,S.cube);let re=L.uniforms.get("u_sky");re!==void 0&&e.uniform1i(re,Er)}if(S.tile){e.activeTexture(e.TEXTURE0+Io),e.bindTexture(e.TEXTURE_2D,S.tile);let re=L.uniforms.get("u_tile");re!==void 0&&e.uniform1i(re,Io)}if(E==="atelier"){let re=K===null?{texture:ie.shadowTexture,window:ie.shadowWindow,ready:ie.shadowTexture!==null&&ie.shadowKey!==null}:Ie(K.shadow);e.activeTexture(e.TEXTURE0+Kt),e.bindTexture(e.TEXTURE_2D,re.texture);let Ae=L.uniforms.get("u_shadow");Ae!==void 0&&e.uniform1i(Ae,Kt),de(L,"u_shadowWindow",re.window),se(L,"u_shadowReady",re.ready?1:0),de(L,"u_keyLight",Dt),se(L,"u_paperGap",Qt)}e.bindVertexArray(j),e.drawArrays(e.TRIANGLES,0,3);let at=null;if(X.motes&&z!==null){let re=M.get("draw:motes");if(re&&re.ready){let Ae=P.blendFunc;at=[Ae.srcRgb,Ae.dstRgb,Ae.srcAlpha,Ae.dstAlpha],e.useProgram(re.program),e.enable(e.BLEND),m.tone==="dark"?e.blendFuncSeparate(e.ONE,e.ONE,e.ZERO,e.ONE):e.blendFuncSeparate(e.ONE,e.ONE_MINUS_SRC_ALPHA,e.ZERO,e.ONE),e.uniformMatrix4fv(re.uniforms.get("u_mvp"),!1,h.mvp),de(re,"u_eye",h.eye),de(re,"u_stageCenter",[Xe.stageX,Xe.centerY,Xe.stageZ]),de(re,"u_stageExtent",[Xe.extentX,Xe.extentY,Xe.extentZ]),se(re,"u_projScale",h.projection[5]),se(re,"u_viewportHeight",h.viewportHeight),se(re,"u_pixelRatio",h.pixelRatio),se(re,"u_time",ze),le(re,"u_ndcTransform",Fe),se(re,"u_planar",h.planar),se(re,"u_dark",m.tone==="dark"?1:0),se(re,"u_opacity",Te),se(re,"u_maxPointSize",f),de(re,"u_tint0",Be[0]),de(re,"u_tint1",Be[1]),e.bindVertexArray(z),e.drawArrays(e.POINTS,0,Mr)}}return e.bindVertexArray(null),e.depthMask(!0),(ct?e.enable:e.disable).call(e,e.BLEND),at!==null&&e.blendFuncSeparate(...at),(Ge?e.enable:e.disable).call(e,e.DEPTH_TEST),e.activeTexture(je),!0}a(lt,"draw");function Ni(h){let m=w.get(h);if(m){I(m.tintJob),I(m.shadowJob);for(let E of[m.shadowTexture,m.shadowSpare])E!==null&&(Qe(e,E),b-=Jt*Jt*4);w.delete(h),Do.delete(h)}}a(Ni,"forgetView");function Tr(h){if(!c){c=!0,U(),x.length=0,g!==null&&clearTimeout(g),g=null,typeof document<"u"&&document.removeEventListener("visibilitychange",G),Q();for(let m of Z)m.reject(new Error("Backdrop look renderer disposed."));if(Z.clear(),!!h){for(let m of M.values())Dr(e,m.program),e.deleteShader(m.vs),e.deleteShader(m.fs);for(let m of _.values())m.cube&&Qe(e,m.cube),m.candidateCube&&Qe(e,m.candidateCube),m.tile&&Qe(e,m.tile),m.framebuffer&&e.deleteFramebuffer(m.framebuffer);for(let m of w.values())m.shadowTexture&&Qe(e,m.shadowTexture),m.shadowSpare&&Qe(e,m.shadowSpare);he&&Qe(e,he),e.deleteVertexArray(j),e.deleteBuffer(N),z&&e.deleteVertexArray(z),C&&e.deleteBuffer(C)}}}a(Tr,"teardown");function Di(){let h={};for(let[E,S]of _)h[E]={ready:S.ready,...S.stats??{}};let m={};for(let[E,S]of w)m[E]=S.shadowStats;return{activeId:l,opacity:u,version:d,textureBytes:b,jobsQueued:x.length,jobHistory:O.slice(),slices:{...$},families:h,shadows:m,ambient:g!==null,parallelCompile:s!==null,programs:[...M.values()].map(E=>({key:E.key,ready:E.ready,failed:E.failed,compileMs:E.readyAt?E.readyAt-E.startedAt:null}))}}a(Di,"getDiagnostics");function Bi(h){if(l===null)return null;let m=ht[l],E=w.get(h)??null,S=(E&&me(E,m))??null,X=m.program==="atelier"?E?.shadowPacked??null:null,K=g!==null?1:0,ie=Do.get(h);if(ie!==void 0&&ie.id===l&&ie.tintsRef===S&&ie.packed===X&&ie.state.time===v&&ie.state.ambient===K)return ie.state;let Te=S??Se(m),L=Object.freeze({id:l,tints:Object.freeze(Te.map(Fe=>Object.freeze([Fe[0],Fe[1],Fe[2]]))),time:v,ambient:K,shadow:X===null?null:Object.freeze({packed:X,window:Object.freeze([...E.shadowWindow]),size:Jt})});return Do.set(h,{id:l,tintsRef:S,packed:X,state:L}),L}a(Bi,"getExportState");let Do=new Map;function Ui(){let h=a(()=>oe(),"check");return h()?Promise.resolve():new Promise((m,E)=>Z.add({check:h,resolve:m,reject:E}))}return a(Ui,"whenReady"),{setLook:q,advance:ge,getExportState:Bi,whenReady:Ui,frameCause:rt,motionCause:Ce,draw:lt,forgetView:Ni,dispose:a(()=>Tr(!0),"dispose"),abandon:a(()=>Tr(!1),"abandon"),isActive:a(()=>l!==null,"isActive"),getVersion:a(()=>d,"getVersion"),setAmbientMotion(h){p=h===!0,ye()},getDiagnostics:Di}}a(Pi,"createBackdropLookRenderer");var no=null;function kl(){if(no!==null&&!no.gl.isContextLost())return no;if(typeof document>"u")throw new Error("Figure export needs a document to draw the background look.");let e=document.createElement("canvas");e.width=1,e.height=1;let t=e.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,preserveDrawingBuffer:!0});if(!t)throw new Error("Figure export needs WebGL2 to draw the background look.");let o=Pi(t,{invalidate:a(()=>{},"invalidate"),prefersReducedMotion:a(()=>!0,"prefersReducedMotion"),readViewSource:a(()=>null,"readViewSource")});return no={canvas:e,gl:t,renderer:o},no}a(kl,"getSharedContext");function Rl(e){let t=new Float32Array(16),o=e[0],r=e[1],i=e[2],n=e[3],s=e[4],f=e[5],c=e[6],l=e[7],u=e[8],d=e[9],p=e[10],g=e[11],v=e[12],A=e[13],y=e[14],b=e[15],M=o*f-r*s,_=o*c-i*s,w=o*l-n*s,x=r*c-i*f,O=r*l-n*f,k=i*l-n*c,D=u*A-d*v,$=u*y-p*v,R=u*b-g*v,U=d*y-p*A,B=d*b-g*A,V=p*b-g*y,I=M*V-_*B+w*U+x*R-O*$+k*D;if(!Number.isFinite(I)||Math.abs(I)<1e-30)return null;let j=1/I;return t[0]=(f*V-c*B+l*U)*j,t[1]=(i*B-r*V-n*U)*j,t[2]=(A*k-y*O+b*x)*j,t[3]=(p*O-d*k-g*x)*j,t[4]=(c*R-s*V-l*$)*j,t[5]=(o*V-i*R+n*$)*j,t[6]=(y*w-v*k-b*_)*j,t[7]=(u*k-p*w+g*_)*j,t[8]=(s*B-f*R+l*D)*j,t[9]=(r*R-o*B-n*D)*j,t[10]=(v*O-A*w+b*M)*j,t[11]=(d*w-u*O-g*M)*j,t[12]=(f*$-s*U-c*D)*j,t[13]=(o*U-r*$+i*D)*j,t[14]=(A*_-v*x-y*M)*j,t[15]=(u*x-d*_+p*M)*j,t}a(Rl,"invert4");async function Ii({renderState:e,width:t,height:o,ndcTransform:r,pixelScale:i,signal:n=null}){let s=e?.backdrop?.look??null;if(s===null||!Nt(s.id))throw new TypeError("Figure export render state names no background look.");if(!(Number.isInteger(t)&&t>0&&Number.isInteger(o)&&o>0))throw new TypeError("Figure export background-look raster needs a positive integer size.");let{canvas:f,gl:c,renderer:l}=kl();l.setLook(s.id),await l.whenReady(),Gr(n);let u=Math.min(c.getParameter(c.MAX_RENDERBUFFER_SIZE),...c.getParameter(c.MAX_VIEWPORT_DIMS)),d=Math.min(1,u/t,u/o),p=Math.max(1,Math.floor(t*d)),g=Math.max(1,Math.floor(o*d));f.width=p,f.height=g,c.viewport(0,0,p,g);let v=Float32Array.from(e.mvpMatrix),A=Rl(v);if(A===null)throw new Error("Figure export cannot draw the background look: the camera is singular.");let y=e.backdrop,b=i*d;if(!l.draw({viewId:"figure-export",invMvp:A,mvp:v,projection:Float32Array.from(e.projectionMatrix),eye:Float32Array.from(e.cameraPosition),pixelRatio:y.pixelRatio*b,glowCenterX:y.glowCenterX,viewportWidth:e.viewportWidth*b,viewportHeight:e.viewportHeight*b,planar:y.planarity>=.5?1:0,geometry:y,ndcTransform:r,frozen:s}))throw new Error(`Figure export could not draw the "${s.id}" background look.`);let _=document.createElement("canvas");_.width=t,_.height=o;let w=_.getContext("2d");return w.imageSmoothingEnabled=!0,w.imageSmoothingQuality="high",w.drawImage(f,0,0,t,o),_}a(Ii,"renderBackdropLookRaster");function vu(e,t,o){return e?.kind==="look"&&t?.viewerPaper===!0&&o?.backdrop?.look!=null}a(vu,"figureDrawsBackdropLook");function $l({renderState:e,plotRect:t,crop:o=null}){let{source:r,scale:i}=Pt({renderState:e,plotRect:t,crop:o}),n=r.viewportWidth,s=r.viewportHeight;return{ndcTransform:[r.width/n,r.height/s,2*(r.x+r.width/2)/n-1,1-2*(r.y+r.height/2)/s],viewportPerPlot:1/i}}a($l,"resolveBackdropLookPlacement");async function Fl({renderState:e,plotRect:t,crop:o=null,width:r,height:i,signal:n=null}){let{ndcTransform:s,viewportPerPlot:f}=$l({renderState:e,plotRect:t,crop:o}),c=r/t.width/f;return Ii({renderState:e,width:r,height:i,ndcTransform:s,pixelScale:c,signal:n})}a(Fl,"renderBackdropLookForPlot");function Eu(e,t){return`<image class="cellucid-backdrop-look" x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" href="${e}" preserveAspectRatio="none"/>`}a(Eu,"renderSvgBackdropLookImage");var it={key:null,canvas:null,pending:null};function _u({renderState:e,plotRect:t,crop:o,width:r,height:i},n){let s=e.backdrop.look,f=JSON.stringify([s.id,s.tints,s.time,s.shadow?.window??null,Array.from(e.mvpMatrix),e.viewportWidth,e.viewportHeight,t,o,r,i]);return it.key===f&&it.canvas!==null?it.canvas:(it.pending!==f&&(it.pending=f,Fl({renderState:e,plotRect:t,crop:o,width:r,height:i}).then(c=>{it.pending===f&&(it.key=f,it.canvas=c,it.pending=null,n())}).catch(c=>{it.pending===f&&(it.pending=null),console.warn("[FigureExport] Background-look preview failed:",c)})),null)}a(_u,"peekBackdropLookPreview");export{eu as a,gr as b,qe as c,Vo as d,gt as e,Ye as f,Dl as g,Zo as h,qt as i,Bl as j,dn as k,Ul as l,hn as m,pn as n,nu as o,Fi as p,Nt as q,wn as r,Pi as s,Ol as t,Zi as u,st as v,zl as w,Cl as x,Ll as y,ea as z,Pl as A,mn as B,Xl as C,ra as D,Wl as E,xn as F,tc as G,oc as H,Tn as I,ka as J,mc as K,yc as L,bc as M,$a as N,xc as O,gc as P,_c as Q,Ic as R,Nc as S,Xn as T,Wn as U,qc as V,Jc as W,ls as X,Hn as Y,Qn as Z,sf as _,lf as $,vf as aa,Fs as ba,kf as ca,Rf as da,Pf as ea,If as fa,Hf as ga,Vf as ha,Zf as ia,qf as ja,vu as ka,Fl as la,Eu as ma,_u as na};
