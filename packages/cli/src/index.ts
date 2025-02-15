import { SignableENR } from '@chainsafe/enr'
import { createFromProtobuf, createSecp256k1PeerId } from '@libp2p/peer-id-factory'
import { multiaddr } from '@multiformats/multiaddr'
import { execSync } from 'child_process'
import debug from 'debug'
import * as fs from 'fs'
import http from 'http'
import jayson from 'jayson/promise/index.js'
import { Level } from 'level'
import { NetworkId, PortalNetwork, fromHexString } from 'portalnetwork'
import * as PromClient from 'prom-client'
import { hideBin } from 'yargs/helpers'
import yargs from 'yargs/yargs'

import { setupMetrics } from './metrics.js'
import { RPCManager } from './rpc/rpc.js'

import type { Enr } from './rpc/schema/types.js'
import type { ClientOpts } from './types.js'
import type { PeerId } from '@libp2p/interface'
import type { NetworkConfig } from 'portalnetwork'

const args: ClientOpts = yargs(hideBin(process.argv))
  .parserConfiguration({
    'dot-notation': false,
  })
  .option('pk', {
    describe: 'base64 string encoded protobuf serialized private key',
    optional: true,
    string: true,
  })
  .option('bootnode', {
    describe: 'ENR of Bootnode',
    string: true,
  })
  .option('bindAddress', {
    describe: 'initial IP address and UDP port to bind to',
    optional: true,
    string: true,
  })
  .option('bootnodeList', {
    describe: 'path to a file containing a list of bootnode ENRs',
    optional: true,
    string: true,
  })
  .option('rpc', {
    describe: 'Enable the JSON-RPC server with HTTP endpoint',
    boolean: true,
    default: true,
  })
  .option('rpcPort', {
    describe: 'HTTP-RPC server listening port',
    number: true,
    default: 8545,
  })
  .option('rpcAddr', {
    describe: 'HTTP-RPC server listening interface address',
    optional: true,
    string: true,
  })
  .option('metrics', {
    describe: 'Turn on Prometheus metrics reporting',
    boolean: true,
    default: false,
  })
  .option('metricsPort', {
    describe: 'Port exposed for metrics scraping',
    number: true,
    default: 18545,
  })
  .option('dataDir', {
    describe: 'data directory where content is stored',
    string: true,
    optional: true,
  })
  .option('web3', {
    describe: 'web3 JSON RPC HTTP endpoint for local Ethereum node for sourcing chain data',
    string: true,
    optional: true,
  })
  .option('networks', {
    describe: 'subnetworks to enable',
    array: true,
    optional: true,
  })
  .option('radiusHistory', {
    describe: `2^r radius for history network client`,
    number: true,
    default: 0,
  })
  .option('radiusBeacon', {
    describe: `2^r radius for beacon network client`,
    number: true,
    default: 0,
  })
  .option('radiusState', {
    describe: `2^r radius for state network client`,
    number: true,
    default: 0,
  })
  .option('trustedBlockRoot', {
    describe: 'a trusted blockroot to start light client syncing of the beacon chain',
    string: true,
    optional: true,
  })
  .strict().argv as ClientOpts

const register = new PromClient.Registry()

const reportMetrics = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200)
  res.end(await register.metrics())
}

const main = async () => {
  const cmd = 'hostname -I'
  const ip =
    args.bindAddress !== undefined
      ? args.bindAddress.split(':')[0]
      : execSync(cmd).toString().split(' ')[0].trim()
  const bindPort = args.bindAddress !== undefined ? args.bindAddress.split(':')[1] : 9000 // Default discv5 port
  const log = debug('ultralight')
  let id: PeerId
  let web3: jayson.Client | undefined
  if (args.pk === undefined) {
    id = await createSecp256k1PeerId()
  } else {
    id = await createFromProtobuf(fromHexString(args.pk))
  }
  const enr = SignableENR.createFromPeerId(id)
  const initMa = multiaddr(`/ip4/${ip}/udp/${bindPort}`)
  enr.setLocationMultiaddr(initMa)

  const metrics = setupMetrics()
  let db
  if (args.dataDir !== undefined) {
    db = new Level<string, string>(args.dataDir)
  }
  const config = {
    enr,
    peerId: id,
    config: {
      enrUpdate: true,
      addrVotesToUpdateEnr: 5,
      allowUnverifiedSessions: true,
      requestTimeout: 3000,
    },
    bindAddrs: {
      ip4: initMa,
    },
    trustedBlockRoot: args.trustedBlockRoot,
  } as any
  let networks: NetworkConfig[] = []
  if (args.networks) {
    for (const network of args.networks) {
      switch (network) {
        case 'history':
          networks.push({
            networkId: NetworkId.HistoryNetwork,
            radius: 2n ** BigInt(args.radiusHistory) - 1n,
          })
          break
        case 'beacon':
          networks.push({
            networkId: NetworkId.BeaconLightClientNetwork,
            radius: 2n ** BigInt(args.radiusBeacon) - 1n,
          })
          break
        case 'state':
          networks.push({
            networkId: NetworkId.StateNetwork,
            radius: 2n ** BigInt(args.radiusState) - 1n,
          })
          break
      }
    }
  } else {
    networks = [{ networkId: NetworkId.HistoryNetwork, radius: 1n }]
  }

  if (args.trustedBlockRoot !== undefined) {
    networks.push({ networkId: NetworkId.BeaconLightClientNetwork, radius: 1n })
  }

  const bootnodes: Array<Enr> = []
  if (args.bootnode !== undefined) {
    bootnodes.push(args.bootnode)
  }
  if (args.bootnodeList !== undefined) {
    const bootnodeData = fs.readFileSync(args.bootnodeList, 'utf-8')
    const bootnodeList = bootnodeData.split('\n')
    for (const bootnode of bootnodeList) {
      bootnodes.push(bootnode)
    }
  }

  const portal = await PortalNetwork.create({
    config,
    //@ts-ignore Because level doesn't know how to get along with itself
    db,
    metrics,
    supportedNetworks: networks,
    dataDir: args.dataDir,
    trustedBlockRoot: args.trustedBlockRoot,
    bootnodes,
  })
  portal.discv5.enableLogs()

  portal.enableLog('*')

  const rpcAddr = args.rpcAddr ?? ip // Set RPC address (used by metrics server and rpc server)
  let metricsServer: http.Server | undefined

  if (args.metrics) {
    metricsServer = http.createServer(reportMetrics)
    for (const entry of Object.entries(metrics)) {
      register.registerMetric(entry[1])
    }
    metricsServer?.listen(args.metricsPort, rpcAddr)
    log(`Started Metrics Server address=http://${rpcAddr}:${args.metricsPort}`)
  }

  await portal.start()

  // Proof of concept for a web3 bridge to import block headers from a locally running full node
  if (args.web3 !== undefined) {
    const [host, port] = args.web3.split(':')
    if (host && port) {
      web3 = jayson.Client.http({ host, port })
    }
  }

  if (args.rpc) {
    const manager = new RPCManager(portal)
    const methods = manager.getMethods()
    const server = new jayson.Server(methods, {
      router(method, params) {
        // `_methods` is not part of the jayson.Server interface but exists on the object
        // but the docs recommend this pattern for custom routing
        // https://github.com/tedeh/jayson/blob/HEAD/examples/method_routing/server.js
        if (this.getMethod(method) === undefined && web3) {
          return new jayson.Method(async function () {
            const res = await web3!.request(method, params)
            if (res.result !== undefined) return res.result
            else return res.error
          })
        } else {
          log(
            `Received ${method} with params: ${
              params !== undefined &&
              (params as any[]).map((p, idx) => {
                return `${idx}: ${p.toString().slice(0, 64)}${
                  p.toString().length > 64 ? '...' : ''
                }`
              })
            }`,
          )
          return this.getMethod(method)
        }
      },
    })
    server.http().listen(args.rpcPort, rpcAddr)

    log(`Started JSON RPC Server address=http://${rpcAddr}:${args.rpcPort}`)
  }

  process.on('SIGINT', async () => {
    console.log('Caught close signal, shutting down...')
    await portal.stop()
    if (metricsServer?.listening === true) {
      metricsServer.close()
    }
    process.exit()
  })
}

main().catch((err) => {
  console.error('Encountered an error', err)
  console.error('Shutting down...')
})
