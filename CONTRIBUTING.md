# Contributing

Bug reports and pull requests are welcome.

- The server is one file (`server.mjs`) and the UI is one file (`ui.html`). Please keep it that way, with no npm dependencies and no build step.
- Run the demo before you open a pull request: `python examples/demo/make-images.py`, start the server, then `node examples/demo/run-demo.mjs round1`. Say in the pull request which backend you tested with.
- If you change a prompt, include the before and after scores for the demo rounds. Prompt changes are easy to make and hard to judge without numbers.
- If you change the UI, update the screenshots with `docs/capture-screenshots.mjs`.
- Never commit anything under `data/` or a `config.json`. They can hold private images and API keys.

For security problems (for example a way to read files outside a project through the API), open an issue that says only that you found one, and the maintainer will reply with a private contact.
