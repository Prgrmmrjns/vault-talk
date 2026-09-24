# Vault Talk

Desk and Jarvis in [Obsidian](https://obsidian.md). The desk is a day view over today's note. Talk or type with [Grok Voice](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech). With **Edit files** on, it can list, read, create, and edit markdown notes. It never deletes.

![Vault Talk](screenshot.png)

Desktop only (microphone).

## How to use

1. Install the plugin and enable it.
2. Open **Settings → Vault Talk**. Paste xAI, OpenAI, Google, and/or Anthropic keys. Pick Speech to text, Talk, and Chat (Cursor, OpenAI, Anthropic, Gemini, Mistral, or Ollama).
3. The desk opens on startup (ribbon **sunrise**, or **Open desk**). Jarvis sits on that view. The ribbon **audio-lines** icon opens chat if the desk is hidden.
4. **Chat** is Ctrl+X (status bar, or the Chat chip). It opens the conversation. **Dictate** is Ctrl+D — speech is typed into the open note. Escape stops either.

Tone and instructions live in vault `Jarvis.md` (`{{date}}`, `{{file}}`, `{{journal}}`, `{{tabs}}`). Accent defaults to orange.

Internet is **off** by default.

## Privacy

Voice and dictation use the Speech to text / Talk providers you pick (Grok, ChatGPT, Google, local Whisper/Kokoro, or Mistral). Chat can use Cursor, OpenAI, Anthropic, Gemini, Mistral, or local Ollama. Do not enable writes on vaults you would not trust with the provider you picked.

## Commands

- Open Jarvis
- Toggle dictation

## Development

```bash
npm install
npm run build
```

Symlink `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/vault-talk`.
