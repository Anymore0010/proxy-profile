// 由 tools/convert-plugins.mjs 生成：为 QX `script-echo-response` 返回固定 body。
// 不能改用 `echo-response` —— 它的正文只接受本机 Data 目录里的文件，远程配置投递不了。
// 来源：Loon 插件的 mock-response-body / response.body.mock(...) 动作。
const bytes = [0,0,0,0,0];
const buf = new ArrayBuffer(bytes.length);
const view = new Uint8Array(buf);
for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
if (typeof $done === 'function') { $done({ bodyBytes: buf }); }
