// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2020 - 2021 Quentin Gruber
//   copyright (C) 2021 - 2022 H1emu community
//
//   https://github.com/QuentinGruber/h1z1-server
//   https://www.npmjs.com/package/h1z1-server
//
//   Based on https://github.com/psemu/soe-network
// ======================================================================

import { EventEmitter } from "events";
import { RC4 } from "h1emu-core";

const debug = require("debug")("SOEInputStream");

export class SOEInputStream extends EventEmitter {
  _sequences: Array<number>;
  _nextSequence: number;
  _lastAck: number;
  _nextFragment: number;
  _lastProcessedFragment: number;
  _fragments: Array<any>;
  _useEncryption: boolean;
  _rc4: RC4;

  constructor(cryptoKey: Uint8Array) {
    super();
    this._sequences = [];
    this._nextSequence = -1;
    this._lastAck = -1;
    this._nextFragment = 0;
    this._lastProcessedFragment = -1;
    this._fragments = [];
    this._useEncryption = false;
    this._rc4 = new RC4(cryptoKey);
  }

  _processDataFragments(): void {
    const nextFragment = (this._lastProcessedFragment + 1) & 0xffff,
      fragments = this._fragments,
      head = fragments[nextFragment];
    let data,
      totalSize,
      dataSize,
      fragment,
      appData = [],
      k;
    if (head) {
      if (head.singlePacket) {
        this._lastProcessedFragment = nextFragment;
        appData = parseChannelPacketData(head);
        fragments[nextFragment] = null;
      } else {
        totalSize = head.readUInt32BE(0);
        dataSize = head.length - 4;

        data = ZeroBuffer(totalSize);
        head.copy(data, 0, 4);

        const fragmentIndices = [nextFragment];
        for (let i = 1; i < fragments.length; i++) {
          const j = (nextFragment + i) % 0xffff;
          fragment = fragments[j];
          if (fragment) {
            fragmentIndices.push(j);
            fragment.copy(data, dataSize);
            dataSize += fragment.length;

            if (dataSize > totalSize) {
              throw (
                "processDataFragments: offset > totalSize: " +
                dataSize +
                " > " +
                totalSize +
                " (sequence " +
                j +
                ") (fragment length " +
                fragment.length +
                ")"
              );
            }
            if (dataSize === totalSize) {
              for (k = 0; k < fragmentIndices.length; k++) {
                fragments[fragmentIndices[k]] = null;
              }
              this._lastProcessedFragment = j;
              appData = parseChannelPacketData(data);
              break;
            }
          } else {
            break;
          }
        }
      }
    }

    if (appData.length) {
      for (let i = 0; i < appData.length; i++) {
        data = appData[i];
        if (this._useEncryption) {
          // sometimes there's an extra 0x00 byte in the beginning that trips up the RC4 decyption
          /*
                      Hey @jseidelin i've found what's this extra byte :P
                      From the UdpLibrary doc:
                      - Implementation note:  Internally the UdpLibrary needs a way to distinguish internal packets from application packets.
                      It does this by having all internal packets start with a zero (0) byte.
                    */
          if (data.length > 1 && data.readUInt16LE(0) === 0) {
            data = Buffer.from(
              this._rc4.encrypt(new Uint32Array(data.slice(1)))
            );
          } else {
            data = Buffer.from(this._rc4.encrypt(new Uint32Array(data)));
          }
        }
        this.emit("data", null, data);
      }
      setImmediate(() => {
        this._processDataFragments();
      });
    }
  }

  write(data: Buffer, sequence: number, fragment: any): void {
    if (this._nextSequence === -1) {
      this._nextSequence = sequence;
    }
    debug(
      "Writing " + data.length + " bytes, sequence " + sequence,
      " fragment=" + fragment + ", lastAck: " + this._lastAck
    );
    this._fragments[sequence] = data;
    if (!fragment) {
      this._fragments[sequence].singlePacket = true;
    }

    //debug(sequence, this._nextSequence);
    if (sequence > this._nextSequence) {
      debug(
        "Sequence out of order, expected " +
          this._nextSequence +
          " but received " +
          sequence
      );
      this.emit("outoforder", null, this._nextSequence, sequence);
    } else {
      let ack = sequence;
      for (let i = 1; i < this._sequences.length; i++) {
        const j = (this._lastAck + i) & 0xffff;
        if (this._fragments[j]) {
          ack = j;
        } else {
          break;
        }
      }
      if (ack > this._lastAck) {
        this._lastAck = ack;
        this.emit("ack", null, ack);
      }
      this._nextSequence = this._lastAck + 1;

      this._processDataFragments();
    }
  }

  setEncryption(value: boolean): void {
    this._useEncryption = value;
    debug("encryption: " + this._useEncryption);
  }

  toggleEncryption(): void {
    this._useEncryption = !this._useEncryption;
    debug("Toggling encryption: " + this._useEncryption);
  }
}

function ZeroBuffer(length: number): Buffer {
  const buffer: Buffer = new (Buffer as any).alloc(length);
  for (let i = 0; i < length; i++) {
    buffer[i] = 0;
  }
  return buffer;
}

function readDataLength(
  data: Buffer,
  offset: number
): { value: number; numBytes: number } {
  let dataLength = data.readUInt8(offset),
    n;
  if (dataLength === 0xff) {
    if (data[offset + 1] === 0xff && data[offset + 2] === 0xff) {
      dataLength = data.readUInt32BE(offset + 3);
      n = 7;
    } else {
      dataLength = data.readUInt16BE(offset + 1);
      n = 3;
    }
  } else {
    n = 1;
  }
  return {
    value: dataLength,
    numBytes: n,
  };
}

function parseChannelPacketData(data: Buffer): any {
  let appData: any = [],
    offset,
    dataLength;
  if (data[0] === 0x00 && data[1] === 0x19) {
    offset = 2;
    while (offset < data.length) {
      dataLength = readDataLength(data, offset);
      offset += dataLength.numBytes;
      appData.push(data.slice(offset, offset + dataLength.value));
      offset += dataLength.value;
    }
  } else {
    appData = [data];
  }
  return appData;
}
