/** Variables a command needs that only look like secrets. */
const KEEP = new Set(["SSH_AUTH_SOCK", "XAUTHORITY"]);
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/**
 * Environment for the agent's commands: the user's, minus anything that
 * looks like a key, token or password. A command (or a package script it
 * starts) then can't print or send the API keys the editor was started with.
 */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (KEEP.has(name) || !SECRET_NAME.test(name)) out[name] = value;
  }
  // Nobody can answer a prompt: commands must not wait for input.
  out.CI = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}
