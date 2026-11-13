-- The engine's database (opencode.db), opencode 2 with opencode 1's table kept: what OpenCode's
-- hosted models cost. Read by the box's usage-grok-hosted.test.ts and UsageKit's UsageBoxParityTests.
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
INSERT INTO message VALUES ('m-go-1','s1',1794304800000,1794304800000,'{"role":"assistant","providerID":"opencode-go","modelID":"glm-5.2","cost":0.25,"tokens":{"total":5000,"input":1}}');
INSERT INTO session_message VALUES ('m-go-1','s2','assistant',1,1794304800000,1794304800000,'{"model":{"id":"glm-5.2","providerID":"opencode-go"},"cost":0.25,"tokens":{"input":4000,"output":900}}');
INSERT INTO message VALUES ('m-user','s1',1794304860000,1794304860000,'{"role":"user","providerID":"opencode-go","modelID":"glm-5.2","cost":1}');
INSERT INTO message VALUES ('m-zen-1','s1',1794308400000,1794308400000,'{"role":"assistant","providerID":"opencode","modelID":"claude-sonnet-5","cost":2,"tokens":{"input":100,"output":50,"reasoning":25,"cache":{"read":20,"write":5}}}');
INSERT INTO session_message VALUES ('m-zen-2','s2','assistant',2,1794398400000,1794398400000,'{"model":{"id":"gpt-5.5","providerID":"opencode"},"cost":0.125,"tokens":{"input":1000,"output":200,"reasoning":50,"cache":{"read":300,"write":10}}}');
INSERT INTO session_message VALUES ('m-go-2','s2','assistant',3,1794400200000,1794400200000,'{"model":{"id":"kimi-k3","providerID":"opencode-go"},"cost":0.0625,"tokens":{"total":"750"}}');
INSERT INTO session_message VALUES ('m-go-3','s2','compaction',4,1794402000000,1794402000000,'{"status":"completed","reason":"auto","model":{"id":"glm-5.2","providerID":"opencode-go"},"cost":0.5,"tokens":{"input":100}}');
INSERT INTO session_message VALUES ('m-go-4','s2','compaction',5,1794402000000,1794402000000,'{"status":"running","reason":"auto","model":{"id":"glm-5.2","providerID":"opencode-go"},"cost":9,"tokens":{"input":1}}');
INSERT INTO session_message VALUES ('m-zen-3','s2','assistant',6,1794477600000,1794477600000,'{"model":{"id":"big-pickle","providerID":"opencode"},"cost":0,"tokens":{"input":800,"output":200}}');
INSERT INTO session_message VALUES ('m-go-5','s2','assistant',7,1794479400000,1794479400000,'{"model":{"providerID":"opencode-go"},"cost":0.03125,"tokens":{"input":60,"output":40}}');
INSERT INTO session_message VALUES ('m-byo','s2','assistant',8,1794481200000,1794481200000,'{"model":{"id":"claude-opus-5","providerID":"anthropic"},"cost":3,"tokens":{"input":1}}');
INSERT INTO session_message VALUES ('m-openai','s2','assistant',9,1794481200000,1794481200000,'{"model":{"id":"gpt-5.5","providerID":"openai"},"cost":0,"tokens":{"input":1}}');
INSERT INTO session_message VALUES ('m-text','s2','assistant',10,1794481200000,1794481200000,'{"model":{"id":"glm-5.2","providerID":"opencode-go"},"cost":"1.5","tokens":{"input":1}}');
INSERT INTO session_message VALUES ('m-nocost','s2','assistant',11,1794481200000,1794481200000,'{"model":{"id":"glm-5.2","providerID":"opencode-go"},"tokens":{"input":1}}');
INSERT INTO session_message VALUES ('m-bad','s2','assistant',12,1794481200000,1794481200000,'{not json');
INSERT INTO session_message VALUES ('m-neg','s2','assistant',13,1794481200000,1794481200000,'{"model":{"id":"glm-5.2","providerID":"opencode-go"},"cost":-1,"tokens":{"input":1}}');
INSERT INTO session_message VALUES ('m-old','s2','assistant',14,1788264000000,1788264000000,'{"model":{"id":"glm-5.2","providerID":"opencode-go"},"cost":7,"tokens":{"input":1}}');
