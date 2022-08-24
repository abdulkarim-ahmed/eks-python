import { Construct } from "constructs";
import { Duration, SecretValue } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";

export class EcsPythonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // creating a vpc with private and public subnets to test
    const vpc = new ec2.Vpc(this, "python-ecs-vpc", {
      cidr: "10.1.0.0/16",
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, subnetType: ec2.SubnetType.PUBLIC, name: "Public" },
        {
          cidrMask: 24,
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
          name: "Private",
        },
      ],
      maxAzs: 3, // Default is all AZs in region
    });

    // create a cluster
    const cluster = new ecs.Cluster(this, "python-ecs-vpc-cluster", {
      vpc: vpc,
    });

    // the allowed permissions for fargate
    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ["*"],
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
    });

    // creating task Definition
    const fargateTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ApiTaskDefinition",
      {
        memoryLimitMiB: 512,
        cpu: 256,
      }
    );
    fargateTaskDefinition.addToExecutionRolePolicy(executionRolePolicy);

    // creating container used in fargate
    const container = fargateTaskDefinition.addContainer("backend", {
      containerName: "python-ecs-api-container",
      // Use an image from Amazon ECR
      image: ecs.ContainerImage.fromRegistry(
        "059242425524.dkr.ecr.us-east-2.amazonaws.com/eksws-codepipeline-ecrdockerrepository-n8c8jvw32szc" // can be added in env vars
      ),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "python-ecs-api" }),
      environment: {
        APP_ID: "my-app",
      },
    });

    // port on which application inside the container is running
    container.addPortMappings({
      containerPort: 5000,
    });

    // creating a sercuity group and allowing all inbounds
    const sg_service = new ec2.SecurityGroup(this, "python-ecs-MySGService", {
      vpc: vpc,
    });
    sg_service.addIngressRule(ec2.Peer.ipv4("0.0.0.0/0"), ec2.Port.tcp(3000));

    // creating service on the tasks
    const service = new ecs.FargateService(this, "python-ecs-Service", {
      cluster,
      taskDefinition: fargateTaskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
      securityGroups: [sg_service],
    });

    // Setup AutoScaling policy
    const scaling = service.autoScaleTaskCount({
      maxCapacity: 6,
      minCapacity: 2,
    });
    scaling.scaleOnCpuUtilization("python-ecs-CpuScaling", {
      targetUtilizationPercent: 50,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });

    // Setup load balancer
    const lb = new elbv2.ApplicationLoadBalancer(this, "python-ecs-ALB", {
      vpc,
      internetFacing: true,
    });

    const listener = lb.addListener("Listener", {
      port: 80,
    });
    listener.addTargets("Target", {
      port: 80,
      targets: [service],
    });

    listener.connections.allowDefaultPortFromAnyIpv4("Open to the world");

    // Pipeline
    const project = new codebuild.PipelineProject(this, "MyProject", {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_2_0,
        privileged: true,
        environmentVariables: {
          AWS_ACCOUNT_ID: {
            value: "059242425524",
          },
          AWS_DEFAULT_REGION: {
            value: "us-east-2",
          },
          CONTAINER_NAME: {
            value: "python-ecs-api-container",
          },
          DockerFilePath: {
            value: "dockerfile",
          },
          IMAGE_TAG: {
            value: "latest",
          },
          IMAGE_REPO_NAME: {
            value: "059242425524.dkr.ecr.us-east-2.amazonaws.com/eksws-codepipeline-ecrdockerrepository-n8c8jvw32szc",
          },
          
        },
      },
    });
    const buildRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ["*"],
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetRepositoryPolicy",
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
      ],
    });
    project.addToRolePolicy(buildRolePolicy);

    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: "GithubSource",
      owner: "AayKaay",
      repo: "eks-python",
      branch: "master",
      oauthToken: SecretValue.secretsManager("gh_key"),
      output: sourceOutput,
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "CodeBuild",
      project,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    const manualAction = new codepipeline_actions.ManualApprovalAction({
      actionName: "CTOApproval",
    });

    new codepipeline.Pipeline(this, "MyPipeline", {
      stages: [
        {
          stageName: "Source",
          actions: [sourceAction],
        },
        {
          stageName: "Build",
          actions: [buildAction],
        },
        {
          stageName: "CTO_Approval",
          actions: [manualAction],
        },
        {
          stageName: "Deploy",
          actions: [
            new codepipeline_actions.EcsDeployAction({
              actionName: "ECS-Service",
              service: service,
              input: buildOutput,
            }),
          ],
        },
      ],
    });
  }
}
