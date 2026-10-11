FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/social-core .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/social-core /social-core
EXPOSE 8082
ENTRYPOINT ["/social-core"]
