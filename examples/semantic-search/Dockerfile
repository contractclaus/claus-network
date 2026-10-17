FROM docker.io/library/python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d AS build
WORKDIR /app
COPY examples/semantic-search/model-lock.json examples/semantic-search/fetch_assets.py ./
RUN python fetch_assets.py && python -m pip install --no-cache-dir --no-deps wheels/*.whl && for package in native/*.deb; do dpkg-deb -x "$package" /native; done && rm -rf wheels native

FROM docker.io/library/python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 PORT=8080 LD_LIBRARY_PATH=/usr/local/lib/claus-native
WORKDIR /app
COPY --from=build /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=build /native/usr/lib/x86_64-linux-gnu /usr/local/lib/claus-native
COPY --from=build /app/model /app/model
COPY examples/semantic-search/model-lock.json examples/semantic-search/server.py examples/semantic-search/LICENSE ./
USER 10001:10001
EXPOSE 8080
CMD ["python", "server.py"]
