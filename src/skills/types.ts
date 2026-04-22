export interface Skill {
  id: string;                 // slash-prefixed, e.g. "/automation"
  label: string;              // shown in popover
  description: string;        // short subtitle
  systemPrompt: string;       // appended to system message when active
  // When true, the callback URL / token / session id runtime block is
  // appended to the system prompt for that turn. Skills that don't need
  // the local HTTP server don't get these fields, keeping the prompt lean.
  injectCallbackContext?: boolean;
}
