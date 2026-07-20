# Yield AI — containerized in-house model server.
#
# Built on vLLM's official OpenAI-compatible image (CUDA + vLLM already inside).
# Build:  docker build -t yield-ai ./yield-ai
# Run:    docker run --gpus all -p 8000:8000 --env-file yield-ai/.env yield-ai
#
# The container reads the same YIELD_AI_* env vars as serve.sh (pass them with
# --env-file or -e). Your endpoint is then http://<host>:8000/v1.
FROM vllm/vllm-openai:latest

# A writable HF cache so model weights persist if you mount a volume at /root/.cache.
ENV HF_HOME=/root/.cache/huggingface

WORKDIR /yield-ai
COPY serve.sh /yield-ai/serve.sh
COPY yield-ai.system.txt /yield-ai/yield-ai.system.txt
RUN chmod +x /yield-ai/serve.sh

# The base image sets an ENTRYPOINT to vLLM's server; override it so our script drives.
ENTRYPOINT []
EXPOSE 8000
CMD ["/yield-ai/serve.sh"]
