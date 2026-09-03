ARG PYTHON_IMAGE=python:3.12-slim-bookworm
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        apt_sources=/etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
        apt_sources=/etc/apt/sources.list; \
    else \
        echo 'No Debian APT sources file found' >&2; \
        exit 1; \
    fi; \
    cp "$apt_sources" /tmp/debian.sources.original; \
    apt_ready=0; \
    for mirror in \
        mirrors.aliyun.com \
        mirrors.tuna.tsinghua.edu.cn \
        mirrors.ustc.edu.cn \
        deb.debian.org; do \
        cp /tmp/debian.sources.original "$apt_sources"; \
        sed -i \
            -e "s|deb.debian.org|$mirror|g" \
            -e "s|security.debian.org|$mirror|g" \
            "$apt_sources"; \
        if apt-get -o Acquire::Retries=2 update; then \
            apt_ready=1; \
            break; \
        fi; \
    done; \
    if [ "$apt_ready" -ne 1 ]; then \
        echo 'All Debian APT mirrors failed' >&2; \
        exit 1; \
    fi; \
    apt-get install --no-install-recommends -y \
        fonts-noto-cjk \
        libreoffice-calc \
        libreoffice-core \
        libreoffice-draw \
        libreoffice-impress \
        libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system rag \
    && useradd --system --gid rag --create-home rag \
    && mkdir -p /srv/rag/artifacts /srv/rag/lightrag /srv/rag/backups /srv/rag/input \
    && chown -R rag:rag /srv/rag

WORKDIR /app

COPY requirements.txt ./
RUN set -eux; \
    pip_ready=0; \
    for index in \
        https://pypi.tuna.tsinghua.edu.cn/simple \
        https://mirrors.aliyun.com/pypi/simple \
        https://pypi.mirrors.ustc.edu.cn/simple \
        https://pypi.org/simple; do \
        if pip install --no-cache-dir \
            --index-url "$index" \
            --timeout 60 \
            --retries 2 \
            -r requirements.txt; then \
            pip_ready=1; \
            break; \
        fi; \
    done; \
    if [ "$pip_ready" -ne 1 ]; then \
        echo 'All Python package indexes failed' >&2; \
        exit 1; \
    fi

COPY . ./
RUN chown -R rag:rag /app /srv/rag

USER rag
