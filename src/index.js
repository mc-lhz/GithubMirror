/**
 * 反向代理 Worker（Base32 单层子域编码版，免费 Universal SSL 即可覆盖）
 *
 * 用法：把源站 host 做 Base32 编码后，作为「mc-lhz.de5.net 下的一级子域」访问。
 *   例：github.com  --Base32-->  MFRGGIBTGI
 *       访问 https://mfrggibtgi.mc-lhz.de5.net/  即代理到  https://github.com/
 *
 * 域名后缀（mc-lhz.de5.net）可在 wrangler.toml 的 [vars] SUFFIX 中配置。
 *
 * 目标：让浏览器全部走本代理，从而避开「本地 hosts 把 GitHub 相关域名指向 127.0.0.1 →
 * Chrome Private Network Access 拦成 loopback »这类报错。做法分两层：
 *   1) HTML 链接替换：把 text/html 标签属性里的绝对 http(s) URL 的 host 用 Base32 编码成
 *      <base32(host)>.suffix/…（覆盖 href/src/srcset/action、data-*、meta og:* 等）。
 *   2) 运行时全拦截：head 内联首屏请求处理器（立即执行，覆盖 SW 激活前空窗）并注册
 *      /service-worker-request-handler.js（激活后
 *      网络层全拦截）。二者都把「任意外部域名」的请求改写为 <base32(host)>.suffix 走本代理，
 *      不限 github，兜住 JS 动态发起的请求（含 expanded_assets、运行时拼接的头像等）。
 *   非 HTML（CSS/JS/图片/接口）原样透传。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Base32 编码（RFC4648，无填充；仅用 A-Z2-7，确保子域合法）
function base32Encode(input) {
	const bytes = new TextEncoder().encode(input);
	let bitCount = 0, accumulator = 0, encoded = "";
	for (const byte of bytes) {
		accumulator = (accumulator << 8) | byte;
		bitCount += 8;
		while (bitCount >= 5) {
			encoded += BASE32_ALPHABET[(accumulator >>> (bitCount - 5)) & 31];
			bitCount -= 5;
		}
	}
	if (bitCount > 0) encoded += BASE32_ALPHABET[(accumulator << (5 - bitCount)) & 31];
	return encoded;
}

// Base32 解码（RFC4648，无填充；字母表全大写，大小写不敏感）
function base32Decode(input) {
	const str = String(input).toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
	let bitCount = 0, accumulator = 0, decoded = "";
	for (const char of str) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index < 0) continue;
		accumulator = (accumulator << 5) | index;
		bitCount += 5;
		if (bitCount >= 8) {
			decoded += String.fromCharCode((accumulator >>> (bitCount - 8)) & 0xff);
			bitCount -= 8;
			accumulator &= (1 << bitCount) - 1;
		}
	}
	return decoded;
}

// 把绝对 http(s) URL 改写成 <base32(host)>.suffix。相对/锚点/mailto 等原样返回；已是 .suffix 的跳过。
function rewriteOneUrl(urlString, suffix) {
	if (!/^https?:\/\//i.test(urlString)) return urlString;
	let parsedUrl;
	try {
		parsedUrl = new URL(urlString);
	} catch {
		return urlString;
	}
	const upstreamHostname = parsedUrl.hostname.replace(/\.$/, "").toLowerCase();
	if (!upstreamHostname || upstreamHostname.endsWith("." + suffix)) return urlString;
	const encodedLabel = base32Encode(upstreamHostname);
	if (encodedLabel.length > 63) return urlString; // DNS 单标签最长 63
	parsedUrl.protocol = "https:";
	parsedUrl.hostname = encodedLabel + "." + suffix;
	parsedUrl.port = "";
	return parsedUrl.href;
}

// 处理普通属性值以及 srcset 这类「URL + 尺寸」混合串（逗号/空格分隔）。
function rewriteUrlAttr(value, suffix) {
	if (!value) return value;
	if (value.includes(",")) {
		return value
			.split(",")
			.map((segment) => {
				const tokens = segment.trim().split(/\s+/);
				return tokens
					.map((token, index) =>
						index === 0 && /^https?:\/\//i.test(token) ? rewriteOneUrl(token, suffix) : token
					)
					.join(" ");
			})
			.join(",");
	}
	return rewriteOneUrl(value, suffix);
}

// Service Worker 源码：拦截本来源下所有出站 fetch，把指向 github 系域名的请求改写为代理子域。
// SW 在浏览器网络层全拦截，不管请求是页面哪个脚本、以什么方式发起的，都能兜住（含 expanded_assets、
// 运行时拼接的头像等），比页内内联 fetch 补丁可靠得多。
const SW_SOURCE = `const SUFFIX="mc-lhz.de5.net";
const ALPHABET="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function encodeBase32(input){
  var bytes=new TextEncoder().encode(input);
  var bitCount=0,accumulator=0,encoded="";
  for(var i=0;i<bytes.length;i++){
    accumulator=(accumulator<<8)|bytes[i];
    bitCount+=8;
    while(bitCount>=5){
      encoded+=ALPHABET[(accumulator>>>(bitCount-5))&31];
      bitCount-=5;
    }
  }
  if(bitCount>0)encoded+=ALPHABET[(accumulator<<(5-bitCount))&31];
  return encoded;
}
function shouldRewrite(hostname){
  hostname=hostname.toLowerCase();
  // 除已是本代理后缀的请求外，一律改写走代理（覆盖所有外部域名，不限 github）
  return !hostname.endsWith("."+SUFFIX);
}
function rewriteUrl(url){
  if(typeof url!=="string")return url;
  var parsed;
  try{parsed=new URL(url,self.location.origin);}catch(err){return url;}
  var hostname=parsed.hostname.toLowerCase();
  if(!shouldRewrite(hostname)||hostname.endsWith("."+SUFFIX))return url;
  parsed.protocol="https:";
  parsed.port="";
  parsed.hostname=encodeBase32(hostname)+"."+SUFFIX;
  return parsed.href;
}
self.addEventListener("install",function(){self.skipWaiting();});
self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim());});
self.addEventListener("fetch",function(event){
  var req=event.request;
  var rewritten=rewriteUrl(req.url);
  if(rewritten===req.url)return;
  var fetchOptions={redirect:"follow",headers:req.headers};
  if(req.method!=="GET"&&req.method!=="HEAD"){fetchOptions.method=req.method;fetchOptions.body=req.body;}
  event.respondWith(fetch(rewritten,fetchOptions).catch(function(){return new Response(null,{status:502});}));
});`;

// 首屏请求处理器：**内联**注入到页面 <head> 的脚本（随 HTML 立即执行，无需独立文件）。
// 与 SW 的区别：SW 需先注册并在浏览器网络层才可全拦截；此脚本在 head 内联执行，覆盖 SW 激活前
// 的首次导航空窗，把页面发起的 request 改写走代理。限制：只能兜住 window.fetch/XHR 显式调用；
// 已缓存 fetch 引用或非标准发起方式拦不到——这正是需要 SW 兜底的原因。
const FIRST_SCREEN_REQUEST_HANDLER_SOURCE = `(function(){
  var SUFFIX="mc-lhz.de5.net",ALPHABET="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function encodeBase32(input){
    var bytes=new TextEncoder().encode(input);
    var bitCount=0,accumulator=0,encoded="";
    for(var i=0;i<bytes.length;i++){
      accumulator=(accumulator<<8)|bytes[i];
      bitCount+=8;
      while(bitCount>=5){
        encoded+=ALPHABET[(accumulator>>>(bitCount-5))&31];
        bitCount-=5;
      }
    }
    if(bitCount>0)encoded+=ALPHABET[(accumulator<<(5-bitCount))&31];
    return encoded;
  }
  function shouldRewrite(hostname){
    hostname=hostname.toLowerCase();
    // 除已是本代理后缀的请求外，一律改写走代理（覆盖所有外部域名，不限 github）
    return !hostname.endsWith("."+SUFFIX);
  }
  function rewriteUrl(url){
    if(typeof url!="string"||!/^https?:/i.test(url))return url;
    try{
      var parsedUrl=new URL(url),hostname=parsedUrl.hostname.toLowerCase();
      if(!shouldRewrite(hostname))return url;
      parsedUrl.protocol="https:";parsedUrl.port="";parsedUrl.hostname=encodeBase32(hostname)+"."+SUFFIX;
      return parsedUrl.href;
    }catch(err){return url;}
  }
  // 支持传入 Request 对象（GitHub 前端常以 fetch(request) 调用，字符串补丁拦不到）
  function rewriteInput(input){
    if(input instanceof Request){
      var rewrittenUrl=rewriteUrl(input.url);
      if(rewrittenUrl===input.url)return input;
      return new Request(rewrittenUrl,input);
    }
    return rewriteUrl(input);
  }
  var nativeFetch=window.fetch;
  if(nativeFetch)window.fetch=function(input,init){return nativeFetch.call(this,rewriteInput(input),init);};
  var nativeXhrOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url,asyncFlag,user,password){return nativeXhrOpen.call(this,method,rewriteUrl(url),asyncFlag,user,password);};
})();`;

// 注入到页面 <head> 的注册脚本：注册并尽快激活上述 SW，让当前页面立刻受控。
const REGISTER_SCRIPT = `<script>
(function(){
  if(!("serviceWorker" in navigator))return;
  var SW_PATH="/service-worker-request-handler.js";
  function forceControl(){
    // 若注册后页面仍未受控，刷新一次让 SW 接管（sessionStorage 防死循环）
    try{
      if(!navigator.serviceWorker.controller&&!sessionStorage.getItem("__proxy_sw_reload")){
        sessionStorage.setItem("__proxy_sw_reload","1");
        location.reload();
      }
    }catch(err){}
  }
  navigator.serviceWorker.register(SW_PATH,{scope:"/"}).then(function(reg){
    if(reg.active)reg.update();
    navigator.serviceWorker.ready.then(forceControl);
    navigator.serviceWorker.addEventListener("controllerchange",forceControl);
  }).catch(function(err){});
})();
<\/script>`;

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const suffix = env.SUFFIX || "mc-lhz.de5.net";

		// 提供 Service Worker 文件（任意代理子域下都可用，供页面 head 注册）
		if (url.pathname === "/service-worker-request-handler.js") {
			return new Response(SW_SOURCE, {
				headers: {
					"Content-Type": "text/javascript;charset=UTF-8",
					"Cache-Control": "no-store",
				},
			});
		}

		// 取一级子域（即 Base32 编码后的上游 host）。缺失/非法时解码结果为空，后续 fetch 会自然报错。
		let label = url.hostname;
		if (label.endsWith("." + suffix)) {
			label = label.slice(0, label.length - suffix.length - 1);
		}
		const upstreamHost = base32Decode(label);

		// 重组目标 URL，保留 path 与 query；上游强制 https；去掉 Accept-Encoding 以便重写 HTML
		url.hostname = upstreamHost;
		url.protocol = "https:";

		const requestHeaders = new Headers(request.headers);
		requestHeaders.delete("accept-encoding");
		let upstreamResponse;
		try {
			upstreamResponse = await fetch(
				new Request(url, {
					method: request.method,
					headers: requestHeaders,
					body: request.body,
					redirect: request.redirect,
				})
			);
		} catch (err) {
			return new Response(null, { status: 502, statusText: "Bad Gateway" });
		}

		// 复制响应头（Response.headers 不可直接修改），补跨域头、删 CSP
		const outHeaders = new Headers(upstreamResponse.headers);
		outHeaders.set("Access-Control-Allow-Origin", "*");
		outHeaders.delete("Content-Security-Policy");
		outHeaders.delete("content-security-policy-report-only");

		const contentType = (upstreamResponse.headers.get("content-type") || "").toLowerCase();

		// 仅对 text/html 做链接替换 + 注入 SW 注册脚本
		if (upstreamResponse.status >= 200 && upstreamResponse.status < 400 && contentType.includes("text/html")) {
			const buildUrlAttributeHandler = (attrName) => ({
				element(element) {
					try {
						const oldValue = element.getAttribute(attrName);
						if (oldValue == null) return;
						const newValue = rewriteUrlAttr(oldValue, suffix);
						if (newValue !== oldValue) element.setAttribute(attrName, newValue);
					} catch (err) {
						// 单个属性改写失败不阻断整个转换流
					}
				},
			});
			// 用显式「元素+属性」选择器，不要用 on("*")（实测会截断 HTML 流）
			const rewritten = new HTMLRewriter()
				.on("a[href],area[href],link[href]", buildUrlAttributeHandler("href"))
				.on("script[src],img[src],iframe[src],embed[src],source[src],video[src],audio[src]", buildUrlAttributeHandler("src"))
				.on("img[srcset],source[srcset]", buildUrlAttributeHandler("srcset"))
				.on("form[action]", buildUrlAttributeHandler("action"))
				.on("link[data-href]", buildUrlAttributeHandler("data-href"))
				.on("link[data-base-href]", buildUrlAttributeHandler("data-base-href"))
				.on("img[data-src]", buildUrlAttributeHandler("data-src"))
				.on("meta[content]", buildUrlAttributeHandler("content"))
				.on("head", {
					element(element) {
						try {
							// 先内联首屏请求处理器（立即执行，覆盖 SW 激活前的空窗），再注册 SW（激活后全拦截）
							element.append(`<script>${FIRST_SCREEN_REQUEST_HANDLER_SOURCE}</script>`, { html: true });
							element.append(REGISTER_SCRIPT, { html: true });
						} catch (err) {
							// 注入失败不阻断页面
						}
					},
				})
				.transform(upstreamResponse);
			const rewrittenHeaders = rewritten.headers;
			rewrittenHeaders.set("Access-Control-Allow-Origin", "*");
			rewrittenHeaders.delete("Content-Security-Policy");
			rewrittenHeaders.delete("content-security-policy-report-only");
			// 重写后长度会变，旧 content-length / content-encoding 必须去掉
			rewrittenHeaders.delete("Content-Length");
			rewrittenHeaders.delete("Content-Encoding");
			return rewritten;
		}

		// 非 HTML（图片/CSS/JS/接口等）或重定向：原样透传
		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: outHeaders,
		});
	},
};