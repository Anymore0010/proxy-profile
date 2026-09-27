# 规则自动转换报告

由 `tools/vendor-rules.mjs` 生成。这些规则原本依赖 Quantumult X 的**运行时资源解析器**
（`opt-parser=true`），现已在本仓库内预转换为 Quantumult X 原生格式。

好处：不依赖运行时解析器、结果可在 git 中审查、被丢弃的规则有记录（而不是只在 iOS 上弹一条通知）。

| 上游来源 | 转换后文件 | 规则数 | 丢弃 |
|---|---|---|---|
| https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-QuantumultX.list | `QuantumultX/rules/filter/AWAvenue.list` | 965 | 0 |
| https://raw.githubusercontent.com/ddgksf2013/Filter/refs/heads/master/AppleIntelligence.list | `QuantumultX/rules/filter/AppleIntelligence.list` | 11 | 0 |
| QuantumultX/rules/filter/My.list + QuantumultX/rules/filter/kelee/BlockAdvertisers.list + https://raw.githubusercontent.com/fmz200/wool_scripts/main/QuantumultX/filter/filter.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/AdvertisingLite/AdvertisingLite.list + QuantumultX/rules/filter/AWAvenue.list + QuantumultX/rules/filter/kelee/Remove_ads_by_keli.list | `QuantumultX/rules/filter/AdsBlock.list` | 40025 | 0 |
| QuantumultX/rules/filter/My.list + QuantumultX/rules/filter/kelee/BlockAdvertisers.list + https://raw.githubusercontent.com/fmz200/wool_scripts/main/QuantumultX/filter/filter.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Advertising/Advertising.list + QuantumultX/rules/filter/AWAvenue.list + QuantumultX/rules/filter/kelee/Remove_ads_by_keli.list | `QuantumultX/rules/filter/AdsBlockFull.list` | 288199 | 0 |
| QuantumultX/rules/rewrite/kelee/Block_HTTPDNS.snippet + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rewrite/QuantumultX/BlockHTTPDNS/BlockHTTPDNS.conf | `QuantumultX/rules/rewrite/HTTPDNSBlock.snippet` | 42 | 0 |
| QuantumultX/rules/rewrite/My.snippet + QuantumultX/rules/rewrite/kelee/BlockAdvertisers.snippet + https://raw.githubusercontent.com/fmz200/wool_scripts/main/QuantumultX/rewrite/rewrite.snippet + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rewrite/QuantumultX/Advertising/Advertising.conf + QuantumultX/rules/rewrite/kelee/Remove_ads_by_keli.snippet + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rewrite/QuantumultX/AdvertisingLite/AdvertisingLite.conf | `QuantumultX/rules/rewrite/AdsBlock.snippet` | 2409 | 0 |
| https://kelee.one/Tool/Loon/Lsr/AI.lsr + https://raw.githubusercontent.com/fmz200/wool_scripts/main/Loon/rule/AI.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/OpenAI/OpenAI.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Anthropic/Anthropic.list | `QuantumultX/rules/filter/AI.list` | 271 | 0 |
| https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Facebook/Facebook.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Instagram/Instagram.list | `QuantumultX/rules/filter/Meta.list` | 571 | 0 |
| https://rule.kelee.one/Loon/Google.lsr + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Google/Google.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/YouTube/YouTube.list | `QuantumultX/rules/filter/Google.list` | 904 | 0 |
| https://kelee.one/Tool/Loon/Lsr/ApplePushNotificationService.lsr | `QuantumultX/rules/filter/ApplePush.list` | 11 | 0 |
|  | `QuantumultX/rules/filter/Apple.list` | 16 | 0 |
| https://rule.kelee.one/Loon/GitHub.lsr + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/GitHub/GitHub.list | `QuantumultX/rules/filter/GitHub.list` | 31 | 0 |
| https://rule.kelee.one/Loon/Twitter.lsr + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Twitter/Twitter.list | `QuantumultX/rules/filter/X.list` | 33 | 0 |
| https://rule.kelee.one/Loon/Telegram.lsr + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Telegram/Telegram.list | `QuantumultX/rules/filter/Telegram.list` | 40 | 0 |
| https://rule.kelee.one/Loon/Spotify.lsr + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Spotify/Spotify.list | `QuantumultX/rules/filter/Spotify.list` | 30 | 0 |
| https://rule.kelee.one/Loon/Netflix.lsr + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Netflix/Netflix.list | `QuantumultX/rules/filter/Netflix.list` | 1158 | 0 |
| https://rule.kelee.one/Loon/Disney.lsr + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Disney/Disney.list | `QuantumultX/rules/filter/Disney.list` | 174 | 0 |

## 选项调整（规则保留）

无。

## 丢弃的规则

无。
