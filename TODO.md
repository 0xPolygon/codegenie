TODO
====

- [x] rename all to codegenie
- [ ] check against trails-api repo directly, lets make sure we don't have .codegenie/ standard
- [ ] check global config works
- [ ] make sure --version returns a version, from package.json and elsewhere
- [ ] lets add a flag to disable all bundled skills.. and allow us to pass our own
overrides ... but i wonder how they will get picked up? so need to check the logic..
a repo might want their own... of course, make it easy for the repo too to pass
in their own skills too.. lets figure out how to do that 
- [ ] gigabrain mode, can we do a second pass on stages with a second llm provider..?
      .. we need to specify [gigabrain] enabled = true, providers = ["antopic/opus-4-8","openai/chatgpt-5.5"]
      .. can we make aliases like "anthropic/latest" and same for "openai" .. ?

- [ ] github integration


