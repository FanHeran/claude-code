# TakoCode (`taco`)

An interactive AI coding assistant for your terminal, wired into the TakoFlow desktop agent.

## Install

```bash
npm i -g @takocode/taco
```

Bins: `taco`, `ccb`, `ccb-bun` (all the same CLI). Runtime: Bun (preferred) or Node.

## Usage

```bash
taco                         # start an interactive session
taco -p "explain this repo"  # one-shot, non-interactive
taco --acp                   # run as an ACP backend (for host apps over stdio)
taco --model haiku           # pick a model (alias or full id)
```

In a session:

```text
/login        # sign in (subscription OAuth or API key)
/provider     # switch provider: anthropic | openai | gemini | grok | bedrock | vertex | foundry
/model        # pick the model
```

## Providers

Anthropic, OpenAI, Gemini, and Grok — via subscription OAuth, API key, or cloud credentials (Bedrock / Vertex / Foundry). Any OpenAI-compatible endpoint works via `OPENAI_BASE_URL`.

## License

See [LICENSE](./LICENSE).
