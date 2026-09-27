// 由 tools/convert-plugins.mjs 生成：为 QX `script-echo-response` 返回固定 body。
// 不能改用 `echo-response` —— 它的正文只接受本机 Data 目录里的文件，远程配置投递不了。
// 来源：Loon 插件的 mock-response-body / response.body.mock(...) 动作。
const bytes = [0,0,0,0,33,26,29,230,144,156,231,180,162,232,167,134,233,162,145,227,128,129,231,149,170,229,137,167,230,136,150,117,112,228,184,187,40,1];
const buf = new ArrayBuffer(bytes.length);
const view = new Uint8Array(buf);
for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
if (typeof $done === 'function') { $done({ bodyBytes: buf }); }
