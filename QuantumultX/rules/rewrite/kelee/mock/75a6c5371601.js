// 由 tools/convert-plugins.mjs 生成：为 QX `script-echo-response` 返回固定 body。
// 不能改用 `echo-response` —— 那个动作的正文只接受本机 Data 目录里的文件，远程配置投递不了。
// 来源：Loon 插件的 mock-response-body / response.body.mock(...) 动作。
const body = "{\"imgIndex\":\"0\",\"adv\":{\"startup_adv\":{\"advCntList\":[],\"buttonList\":[]}},\"respCode\":\"0000\"}";
if (typeof $done === 'function') { $done({ body: body }); }
