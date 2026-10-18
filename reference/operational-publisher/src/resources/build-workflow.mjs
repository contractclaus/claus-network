export const buildWorkflowPath='.github/workflows/claus-owned-build.yml';
// Dependency revisions are retained with the source; changing a tag cannot alter a build.
export const buildWorkflow=`name: Claus owned build
run-name: Claus build \${{ inputs.action }}
on:
  workflow_dispatch:
    inputs:
      action:
        required: true
        type: string
      source:
        required: true
        type: string
      runner:
        required: true
        type: choice
        options: [ubuntu-24.04, ubuntu-24.04-arm]
      minutes:
        required: true
        type: number
      mode:
        required: true
        type: choice
        options: [command, container]
      command:
        required: false
        type: string
      cache:
        required: true
        type: string
      context:
        required: true
        type: string
      dockerfile:
        required: true
        type: string
permissions:
  contents: read
  packages: write
concurrency:
  group: claus-build-\${{ inputs.action }}
  cancel-in-progress: false
jobs:
  build:
    if: github.run_attempt == 1
    runs-on: \${{ inputs.runner }}
    timeout-minutes: \${{ fromJSON(inputs.minutes) }}
    env:
      DOCKER_BUILD_RECORD_UPLOAD: 'false'
      DOCKER_BUILD_SUMMARY: 'false'
      CI_ACTION: \${{ inputs.action }}
      CI_SOURCE: \${{ inputs.source }}
      CI_COMMAND: \${{ inputs.command }}
      CI_MINUTES: \${{ inputs.minutes }}
      CI_CACHE: \${{ inputs.cache }}
    steps:
      - name: Validate immutable request
        shell: bash
        run: |
          [[ "$CI_ACTION" =~ ^act_[a-f0-9]{24}$ ]]
          [[ "$CI_SOURCE" =~ ^[a-f0-9]{40}$ ]]
          [[ "$CI_MINUTES" =~ ^[0-9]+$ ]] && (( CI_MINUTES >= 1 && CI_MINUTES <= 360 ))
          [[ "$CI_CACHE" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: \${{ inputs.source }}
          persist-credentials: false
          fetch-depth: 1
      - name: Restore dependency cache
        if: inputs.mode == 'command'
        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9
        with:
          path: .claus-cache
          key: claus-owned-\${{ runner.arch }}-\${{ inputs.cache }}-\${{ inputs.action }}
          restore-keys: claus-owned-\${{ runner.arch }}-\${{ inputs.cache }}-
      - name: Execute requested build
        if: inputs.mode == 'command'
        shell: bash
        run: |
          mkdir -p .claus-output .claus-cache
          printf '%s' "$CI_COMMAND" | base64 --decode > "$RUNNER_TEMP/claus-command.sh"
          bash -euo pipefail "$RUNNER_TEMP/claus-command.sh"
      - name: Bound dependency cache
        if: inputs.mode == 'command'
        id: cache-size
        shell: bash
        run: |
          if [[ ! -L .claus-cache && -d .claus-cache ]] && [[ $(du -sk .claus-cache | cut -f1) -le 5242880 ]]; then
            echo 'save=true' >> "$GITHUB_OUTPUT"
          fi
      - name: Save dependency cache
        if: inputs.mode == 'command' && steps.cache-size.outputs.save == 'true'
        uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9
        with:
          path: .claus-cache
          key: claus-owned-\${{ runner.arch }}-\${{ inputs.cache }}-\${{ inputs.action }}
      - name: Set up container builder
        if: inputs.mode == 'container'
        uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069
      - name: Authenticate ephemeral package publisher
        if: inputs.mode == 'container'
        uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f
        with:
          registry: ghcr.io
          username: \${{ github.repository_owner }}
          password: \${{ github.token }}
      - name: Build private container
        if: inputs.mode == 'container'
        id: image
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc
        with:
          context: \${{ inputs.context }}
          file: \${{ inputs.dockerfile }}
          push: true
          tags: ghcr.io/\${{ github.repository }}:\${{ inputs.action }}
          labels: |
            org.opencontainers.image.source=https://github.com/\${{ github.repository }}
            org.opencontainers.image.revision=\${{ inputs.source }}
            si.claus.action=\${{ inputs.action }}
          cache-from: type=registry,ref=ghcr.io/\${{ github.repository }}:cache-\${{ runner.arch }}-\${{ inputs.cache }}
          cache-to: type=registry,ref=ghcr.io/\${{ github.repository }}:cache-\${{ runner.arch }}-\${{ inputs.cache }},mode=max
          provenance: mode=min
      - name: Retain build result
        id: bounded-result
        if: always()
        shell: bash
        env:
          IMAGE_DIGEST: \${{ steps.image.outputs.digest }}
          BUILD_STATUS: \${{ job.status }}
        run: |
          python3 - <<'PY'
          import os, json, pathlib, stat
          root=pathlib.Path('.claus-output')
          if root.is_symlink(): raise RuntimeError('output_directory_symlink')
          root.mkdir(exist_ok=True)
          size=0
          for item in root.rglob('*'):
              mode=item.lstat().st_mode
              if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)): raise RuntimeError('output_special_file')
              if stat.S_ISREG(mode): size+=item.stat().st_size
          if size>1024**3: raise RuntimeError('output_over_1GiB_use_object_storage')
          (root/'claus-result.json').write_text(json.dumps({'action':os.environ['CI_ACTION'],'source':os.environ['CI_SOURCE'],'status':os.environ['BUILD_STATUS'],'imageDigest':os.environ.get('IMAGE_DIGEST','')}))
          PY
      - name: Upload retained result
        if: always() && !cancelled() && steps.bounded-result.outcome == 'success'
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9
        with:
          name: claus-build-\${{ inputs.action }}
          path: .claus-output/
          retention-days: 1
          if-no-files-found: ignore
          include-hidden-files: false
`;
