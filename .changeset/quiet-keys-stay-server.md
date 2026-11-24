---
'@ai-sdk/langchain': patch
---

fix(langchain): refuse LangSmith API keys in `LangSmithDeploymentTransport` when running in the browser

The docs, README, and example previously showed passing a LangSmith API key to `LangSmithDeploymentTransport` from client code, which exposes the key to every visitor. In the browser, the transport now throws when it receives an API key (as `apiKey`, as an `x-api-key` header, or stored on a supplied `client`), and it no longer reads API keys from environment variables. Calls to LangSmith deployments that require an API key belong in a server route.
