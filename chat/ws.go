package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WebSocket opcodes (RFC 6455).
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

const maxWSMessageSize = 8 * 1024 // 8 KB

// wsConn wraps a hijacked TCP connection for RFC 6455 WebSocket framing.
type wsConn struct {
	conn net.Conn
	br   *bufio.Reader
}

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("missing Upgrade: websocket header")
	}
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") {
		return nil, errors.New("missing Connection: Upgrade header")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key header")
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("webserver does not support hijacking")
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	accept := computeAcceptKey(key)
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"

	if _, err := conn.Write([]byte(response)); err != nil {
		_ = conn.Close()
		return nil, err
	}

	return &wsConn{
		conn: conn,
		br:   buf.Reader,
	}, nil
}

func computeAcceptKey(key string) string {
	h := sha1.New()
	h.Write([]byte(key))
	h.Write([]byte(wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func headerContainsToken(headerVal, target string) bool {
	for _, part := range strings.Split(headerVal, ",") {
		if strings.EqualFold(strings.TrimSpace(part), target) {
			return true
		}
	}
	return false
}

// readMessage reads the next complete text message, answering pings and handling close frames.
func (c *wsConn) readMessage() ([]byte, error) {
	var payloadBuf []byte
	var messageOpcode byte

	for {
		header := make([]byte, 2)
		if _, err := io.ReadFull(c.br, header); err != nil {
			return nil, err
		}

		fin := (header[0] & 0x80) != 0
		opcode := header[0] & 0x0F
		masked := (header[1] & 0x80) != 0
		length := uint64(header[1] & 0x7F)

		if !masked {
			return nil, errors.New("client frame must be masked")
		}

		switch length {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return nil, err
			}
			length = uint64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return nil, err
			}
			length = binary.BigEndian.Uint64(ext[:])
		}

		if length > maxWSMessageSize || uint64(len(payloadBuf))+length > maxWSMessageSize {
			return nil, errors.New("message too large")
		}

		var maskKey [4]byte
		if _, err := io.ReadFull(c.br, maskKey[:]); err != nil {
			return nil, err
		}

		framePayload := make([]byte, length)
		if length > 0 {
			if _, err := io.ReadFull(c.br, framePayload); err != nil {
				return nil, err
			}
			for i := range framePayload {
				framePayload[i] ^= maskKey[i%4]
			}
		}

		switch opcode {
		case opClose:
			_ = c.writeFrame(opClose, nil)
			return nil, io.EOF
		case opPing:
			if err := c.writeFrame(opPong, framePayload); err != nil {
				return nil, err
			}
			continue
		case opPong:
			continue
		case opText, opBinary:
			messageOpcode = opcode
			payloadBuf = append(payloadBuf, framePayload...)
		case opContinuation:
			if messageOpcode == 0 {
				return nil, errors.New("unexpected continuation frame")
			}
			payloadBuf = append(payloadBuf, framePayload...)
		default:
			return nil, errors.New("unsupported opcode")
		}

		if fin {
			if messageOpcode == opText {
				return payloadBuf, nil
			}
			return nil, errors.New("only text frames are supported")
		}
	}
}

func (c *wsConn) writeText(data []byte) error {
	return c.writeFrame(opText, data)
}

func (c *wsConn) writePing() error {
	return c.writeFrame(opPing, []byte("ping"))
}

func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	n := len(payload)
	var header []byte
	switch {
	case n < 126:
		header = []byte{0x80 | opcode, byte(n)}
	case n <= 0xFFFF:
		header = make([]byte, 4)
		header[0] = 0x80 | opcode
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:], uint16(n))
	default:
		header = make([]byte, 10)
		header[0] = 0x80 | opcode
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:], uint64(n))
	}

	if _, err := c.conn.Write(header); err != nil {
		return err
	}
	if n > 0 {
		if _, err := c.conn.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

func (c *wsConn) close() error {
	return c.conn.Close()
}
